const { getDb } = require('../_lib/mongo');
const { json, handlePreflight, readJsonBody } = require('../_lib/util');
const {
  MAX_SECTION_BYTES, MAX_PAYLOAD_BYTES, MAX_PATCHES_PER_PUSH, PRUNE_EVERY,
  isActorId, isSectionId, authenticate, unauthorized, notFound, tooLarge, sectionTooLarge,
  loadProject, byteLen, prunePatches,
} = require('../_lib/collab');

/* 내 변경분을 올린다.
 *
 * 입력  { sessionToken, collabId, actorId,
 *         patch: {sectionId, html, hash?, baseSeq, ts?}        ← 기본형(섹션 1개)
 *         | patches: [ …같은 모양… ] }                          ← 배열도 받는다
 * 출력  { ok, seq, accepted, conflicts, limits:{section, payload} }
 *
 * ★한 요청 = 섹션 «1개»가 기본이다. 배열도 받지만 실질 제한은 개수가 아니라 합계 크기다 —
 *   이미지 박힌 섹션 둘만 담아도 900KB 를 넘는다.
 *
 * ★413 은 «어느 섹션이 몇 바이트라서» 막혔는지 짚어준다:
 *     { ok:false, reason:'section_too_large', sectionId, bytes, limit }
 *   앱이 사용자에게 「이 섹션은 이미지가 커서 아직 못 올립니다」라고 말할 수 있어야 하기 때문이다.
 *   그냥 413 만 주면 앱은 아무 말도 못 한다.
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
 */
module.exports = async (req, res) => {
  if (handlePreflight(req, res, { origin: '*' })) return;
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });
  res.setHeader('Access-Control-Allow-Origin', '*');

  const LIMITS = { section: MAX_SECTION_BYTES, payload: MAX_PAYLOAD_BYTES };

  let body;
  try { body = await readJsonBody(req); }
  catch (err) {
    if (/too large/i.test(err.message)) {
      return tooLarge(res, { limit: MAX_PAYLOAD_BYTES, field: 'patches' });
    }
    return json(res, 400, { error: 'invalid_body', detail: err.message });
  }

  // 기본형은 patch 하나. 배열(patches)도 그대로 받는다.
  const patches = Array.isArray(body.patches) ? body.patches
    : (body.patch && typeof body.patch === 'object' ? [body.patch] : null);
  if (!patches || !patches.length) return json(res, 400, { ok: false, reason: 'no_patches' });

  /* ★actorId 는 «맨 위에도, 패치 안에도» 올 수 있다 — 실제 앱(js/collab/sync.js)은 패치 안에 넣어 보낸다.
   *   맨 위만 보고 400 을 내면 앱의 모든 push 가 막힌다. 둘 다 받고, 맨 위를 우선한다.
   *   ⛔한 요청 안에서 actorId 가 갈리는 건 허용하지 않는다 — 그러면 에코 방어(pull 의 actorId 제외)가
   *     반쪽이 되어, 내가 보낸 패치 일부를 내가 도로 받는다. */
  const actorId = isActorId(body.actorId) ? body.actorId
    : (patches[0] && isActorId(patches[0].actorId) ? patches[0].actorId : null);
  if (!actorId) return json(res, 400, { ok: false, reason: 'invalid_actor_id' });
  if (patches.some((p) => p && p.actorId !== undefined && p.actorId !== actorId)) {
    return json(res, 400, { ok: false, reason: 'actor_id_mismatch' });
  }
  if (patches.length > MAX_PATCHES_PER_PUSH) {
    return json(res, 400, {
      ok: false, reason: 'too_many_patches', limit: MAX_PATCHES_PER_PUSH, limits: LIMITS,
    });
  }

  // ── 크기 검사는 «인증보다 먼저» 한다. 900KB 를 DB 왕복까지 끌고 갈 이유가 없다.
  let totalBytes = 0;
  for (const p of patches) {
    if (!p || !isSectionId(p.sectionId)) {
      return json(res, 400, { ok: false, reason: 'invalid_section_id' });
    }
    if (typeof p.html !== 'string') {
      return json(res, 400, { ok: false, reason: 'invalid_html', sectionId: p.sectionId });
    }
    const bytes = byteLen(p.html);
    // ★섹션 «하나»가 그대로 한도를 넘는 경우는 실제로 생긴다(이미지 박힌 섹션).
    //   이때만은 어느 섹션인지 반드시 짚어준다 — 앱이 그 섹션을 사용자에게 보여줘야 한다.
    if (bytes > MAX_SECTION_BYTES) {
      return sectionTooLarge(res, { sectionId: p.sectionId, bytes, limit: MAX_SECTION_BYTES });
    }
    totalBytes += bytes;
  }
  if (totalBytes > MAX_PAYLOAD_BYTES) {
    return tooLarge(res, {
      limit: MAX_PAYLOAD_BYTES, bytes: totalBytes, field: 'patches',
      // 섹션 하나하나는 통과했는데 «합쳐서» 넘은 것이다 — 나눠 보내라고 알려준다
      hint: 'split_into_separate_requests', limits: LIMITS,
    });
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
        // ★«최신»부터 가져온다. 오래된 것부터 자르면 상한(200)에 걸렸을 때 정작 방금 들어온
        //   상대의 패치를 못 보고 「충돌 없음」이라고 답한다 — 조용한 오답이다.
      ).sort({ seq: -1 }).limit(200).toArray()
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
        /* ★pageId 를 «반드시» 실어 나른다. 앱은 이걸로 「지금 보는 페이지인가, 다른 페이지인가」를
         *   갈라 처리한다(sync.js applyPatch). 서버가 흘리면 여러 페이지 프로젝트에서
         *   남의 페이지 섹션이 내 페이지에 붙는다. */
        pageId: typeof p.pageId === 'string' ? p.pageId.slice(0, 100) : null,
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

    /* ── ④ 목차(sections) 갱신
     * ★배열을 통째로 $set 하지 않는다 — 동시 push 가 서로의 항목을 날린다.
     *   섹션마다 「있으면 갱신 / 없으면 추가」 두 연산을 넣고 bulkWrite 한 번으로 보낸다.
     *   두 연산 중 «정확히 하나»만 매칭되므로 중복이 생기지 않는다. */
    const ops = [];
    for (const d of docs) {
      ops.push({
        updateOne: {
          filter: { collabId, 'sections.sectionId': d.sectionId },
          update: {
            $set: { 'sections.$.hash': d.hash, 'sections.$.seq': d.seq, 'sections.$.pageId': d.pageId },
          },
        },
      });
      ops.push({
        updateOne: {
          filter: { collabId, 'sections.sectionId': { $ne: d.sectionId } },
          update: {
            $push: {
              sections: {
                sectionId: d.sectionId, pageId: d.pageId, hash: d.hash, seq: d.seq,
              },
            },
          },
        },
      });
    }
    if (ops.length) await db.collection('collab_projects').bulkWrite(ops, { ordered: true });

    // ── ⑤ 정리 (매번 세지 않는다 — PRUNE_EVERY 구간을 넘을 때만)
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
      // ★앱이 한도를 하드코딩하지 않게 성공 응답에도 실어 보낸다
      limits: LIMITS,
    });
  } catch (err) {
    console.error('[collab/push] error', err);
    return json(res, 500, { ok: false, reason: 'internal_error' });
  }
};
