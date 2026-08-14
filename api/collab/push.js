const { getDb } = require('../_lib/mongo');
const { json, handlePreflight, readJsonBody } = require('../_lib/util');
const {
  MAX_HTML_CHARS, MAX_PAYLOAD_CHARS, MAX_PATCHES_PER_PUSH, PRUNE_EVERY,
  isActorId, authenticate, unauthorized, notFound, tooLarge,
  loadProject, jsonSize, prunePatches,
} = require('../_lib/collab');

/* 내 변경분을 올린다.
 *
 * 입력  { sessionToken, collabId, actorId, patches:[{sectionId, html, hash?, baseSeq, ts?}] }
 * 출력  { ok, seq, accepted, conflicts:[{sectionId, seq, baseSeq, conflictWith:[{seq,actorId,hash}]}] }
 *
 * ★서버는 «판정»만 하고 «폐기»는 하지 않는다 (keep-both).
 *   baseSeq 가 서버 seq 보다 뒤처졌고 그 사이 «같은 섹션»을 «다른 사람»이 건드렸으면 충돌이다.
 *   그래도 패치는 그대로 저장하고 conflict 표시만 붙여 돌려준다.
 *   자동 병합을 시도하면(HTML 문자열이다) 조용히 남의 작업을 지운다 — 사람이 고르게 남긴다.
 *
 * ★seq 는 findOneAndUpdate($inc) 로 «원자적으로» 끊어 받는다. 읽고-더하고-쓰면
 *   동시 push 두 개가 같은 seq 를 받고 unique 인덱스에 부딪힌다.
 * ⚠️알려진 한계: 충돌 «검사»와 seq «할당»은 한 트랜잭션이 아니다. 정확히 같은 순간에 들어온
 *   두 push 는 서로를 못 볼 수 있다. 그 경우에도 둘 다 저장되고 다음 pull 에서 양쪽이
 *   서로의 패치를 받는다 — keep-both 라 유실은 없고, 화면에 늦게 뜰 뿐이다.
 *   (2인 협업 + 2초 폴링에서 이 창은 수십 ms 다. 트랜잭션은 Atlas 레플리카셋 의존이라 안 쓴다.)
 */
module.exports = async (req, res) => {
  if (handlePreflight(req, res, { origin: '*' })) return;
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });
  res.setHeader('Access-Control-Allow-Origin', '*');

  let body;
  try { body = await readJsonBody(req); }
  catch (err) {
    if (/too large/i.test(err.message)) {
      return tooLarge(res, { limit: MAX_PAYLOAD_CHARS, field: 'patches' });
    }
    return json(res, 400, { error: 'invalid_body', detail: err.message });
  }

  const actorId = body.actorId;
  if (!isActorId(actorId)) return json(res, 400, { ok: false, reason: 'invalid_actor_id' });

  const patches = Array.isArray(body.patches) ? body.patches : null;
  if (!patches || !patches.length) return json(res, 400, { ok: false, reason: 'no_patches' });
  if (patches.length > MAX_PATCHES_PER_PUSH) {
    return json(res, 400, { ok: false, reason: 'too_many_patches', limit: MAX_PATCHES_PER_PUSH });
  }

  // ── 크기 검사는 «인증보다 먼저» 한다. 900KB 를 DB 왕복까지 끌고 갈 이유가 없다.
  for (const p of patches) {
    if (!p || typeof p.sectionId !== 'string' || !p.sectionId || p.sectionId.length > 100) {
      return json(res, 400, { ok: false, reason: 'invalid_section_id' });
    }
    if (typeof p.html !== 'string') {
      return json(res, 400, { ok: false, reason: 'invalid_html', sectionId: p.sectionId });
    }
    if (p.html.length > MAX_HTML_CHARS) {
      return tooLarge(res, {
        limit: MAX_HTML_CHARS, actual: p.html.length, field: 'html', sectionId: p.sectionId,
      });
    }
  }
  const totalSize = jsonSize(patches);
  if (totalSize > MAX_PAYLOAD_CHARS) {
    return tooLarge(res, { limit: MAX_PAYLOAD_CHARS, actual: totalSize, field: 'patches' });
  }

  try {
    const db = await getDb();
    const user = await authenticate(db, body.sessionToken);
    if (!user) return unauthorized(res);

    const project = await loadProject(db, body.collabId, user.email);
    if (!project) return notFound(res);

    const collabId = project.collabId;
    const patchesCol = db.collection('collab_patches');

    // ── ① 충돌 판정 (저장 전에, 지금까지의 서버 상태 기준으로)
    const minBase = patches.reduce((m, p) => {
      const b = Number.isFinite(p.baseSeq) ? p.baseSeq : 0;
      return Math.min(m, b);
    }, Number.POSITIVE_INFINITY);

    const sectionIds = [...new Set(patches.map((p) => p.sectionId))];
    const rivals = minBase < project.seq
      ? await patchesCol.find(
        { collabId, sectionId: { $in: sectionIds }, seq: { $gt: minBase } },
        { projection: { seq: 1, sectionId: 1, actorId: 1, hash: 1, actorEmail: 1 } },
      ).sort({ seq: 1 }).limit(200).toArray()
      : [];

    // ── ② seq 를 통째로 끊어 받는다(원자적)
    const bumped = await db.collection('collab_projects').findOneAndUpdate(
      { collabId, status: 'active', members: user.email },
      { $inc: { seq: patches.length }, $set: { updatedAt: new Date() } },
      { returnDocument: 'after' },
    );
    // mongodb 드라이버 v6 는 문서를 그대로 준다. v5 이하는 {value}. 둘 다 받는다.
    const after = bumped && bumped.value !== undefined ? bumped.value : bumped;
    if (!after) return notFound(res);

    const endSeq = after.seq;
    const startSeq = endSeq - patches.length + 1;

    // ── ③ 저장 (충돌이어도 저장한다 = keep-both)
    const now = new Date();
    const conflicts = [];
    const docs = patches.map((p, i) => {
      const seq = startSeq + i;
      const baseSeq = Number.isFinite(p.baseSeq) ? p.baseSeq : 0;
      // ★«같은 섹션»을 «다른 사람»이 내 base 이후에 바꿨을 때만 충돌이다.
      //   내가 낸 옛 패치는 충돌이 아니다 — 나 자신과 싸울 이유가 없다.
      const clashed = rivals.filter(
        (r) => r.sectionId === p.sectionId && r.seq > baseSeq && r.actorId !== actorId,
      );
      if (clashed.length) {
        conflicts.push({
          sectionId: p.sectionId,
          seq,
          baseSeq,
          conflictWith: clashed.map((r) => ({
            seq: r.seq, actorId: r.actorId, email: r.actorEmail || null, hash: r.hash || null,
          })),
        });
      }
      return {
        collabId,
        seq,
        sectionId: p.sectionId,
        html: p.html,
        hash: typeof p.hash === 'string' ? p.hash.slice(0, 128) : null,
        baseSeq,
        actorId,
        actorEmail: user.email,
        ts: p.ts ? new Date(p.ts) : now,   // 클라이언트가 말한 시각
        createdAt: now,                    // ★서버 시각 = TTL 기준. 클라 시계를 믿지 않는다.
        conflict: clashed.length > 0,
        conflictWith: clashed.map((r) => r.seq),
      };
    });

    await patchesCol.insertMany(docs, { ordered: true });

    // ── ④ 정리 (매번 세지 않는다 — PRUNE_EVERY 구간을 넘을 때만)
    let patchFloorSeq = project.patchFloorSeq || 1;
    if (Math.floor((startSeq - 1) / PRUNE_EVERY) !== Math.floor(endSeq / PRUNE_EVERY)) {
      const floor = await prunePatches(db, collabId);
      if (floor) patchFloorSeq = floor;
    }

    return json(res, 200, {
      ok: true,
      seq: endSeq,
      accepted: docs.map((d) => ({ sectionId: d.sectionId, seq: d.seq, conflict: d.conflict })),
      conflicts,
      patchFloorSeq,
    });
  } catch (err) {
    console.error('[collab/push] error', err);
    return json(res, 500, { ok: false, reason: 'internal_error' });
  }
};
