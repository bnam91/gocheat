const { getDb } = require('../_lib/mongo');
const { json, handlePreflight, readJsonBody } = require('../_lib/util');
const {
  MAX_PAYLOAD_BYTES, newId, isActorId, authenticate, unauthorized, tooLarge,
  mergeSections, normalizeSections,
} = require('../_lib/collab');

/* 로컬 프로젝트를 «원격으로 올린다» — 정확히는 «방을 연다».
 *
 * 입력  { sessionToken, localProjectId, name, actorId, sections:[{sectionId, hash}] }
 * 출력  { ok, collabId, seq, created, sections:[{sectionId, hash, seq}] }
 *
 * ★★내용(스냅샷)은 «받지 않는다» (2026-08-15 스펙 변경, 지디).
 *   goditor 의 proj.json 은 캔버스에 base64 이미지가 인라인돼 수십 MB 까지 간다(실측 85MB).
 *   Vercel 함수의 본문 한도는 4.5MB 수준이라 통째 업로드는 «구조적으로» 불가능하다.
 *   「일단 받아두고 나중에 쪼갠다」는 답이 아니다 — 첫 사용자가 바로 막힌다.
 *   ⇒ register 는 «목차»(sectionId + hash)만 받아 방을 만들고,
 *     실제 내용은 push 가 섹션 «한 개씩» 올린다. 합류자는 pull(sinceSeq=0)로 쌓아올린다.
 *   ⛔여기에 snapshot·html 을 되살리지 마라. 되살리는 순간 큰 프로젝트가 전부 413 이 된다.
 *
 * ★목차를 왜 서버가 드나: 「누가 무엇을 아직 못 받았나」를 이걸로 판단한다.
 *   목차에 10개인데 상대가 7개만 받았으면 3개가 아직 안 간 것이다.
 *
 * ★멱등이다. 같은 사람이 같은 localProjectId 로 다시 부르면 «기존 방»을 돌려준다.
 *   앱은 재시작·재로그인마다 이걸 부를 수 있어야 한다. 부를 때마다 새 방이 생기면
 *   화면엔 유령 프로젝트가 쌓이고 상대는 어느 방에 있는지 알 수 없게 된다.
 */
module.exports = async (req, res) => {
  if (handlePreflight(req, res, { origin: '*' })) return;
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });
  res.setHeader('Access-Control-Allow-Origin', '*');

  let body;
  try { body = await readJsonBody(req); }
  catch (err) {
    // readJsonBody 는 1MB 를 넘으면 던진다 — 400(형식 오류)이 아니라 413(크기)으로 갈라 말한다
    if (/too large/i.test(err.message)) return tooLarge(res, { limit: MAX_PAYLOAD_BYTES });
    return json(res, 400, { error: 'invalid_body', detail: err.message });
  }

  const localProjectId = typeof body.localProjectId === 'string' ? body.localProjectId.trim() : '';
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 200) : '';
  if (!localProjectId || localProjectId.length > 200) {
    return json(res, 400, { ok: false, reason: 'invalid_local_project_id' });
  }
  // actorId 는 앱이 만든다(설치 단위). 서버는 만들지 않고 받아서 기록만 한다.
  if (body.actorId !== undefined && !isActorId(body.actorId)) {
    return json(res, 400, { ok: false, reason: 'invalid_actor_id' });
  }

  const sections = normalizeSections(body.sections);
  if (sections === null) return json(res, 400, { ok: false, reason: 'invalid_sections' });

  try {
    const db = await getDb();
    const user = await authenticate(db, body.sessionToken);
    if (!user) return unauthorized(res);

    const projects = db.collection('collab_projects');
    const existing = await projects.findOne({
      ownerEmail: user.email, localProjectId, status: 'active',
    });

    if (existing) {
      // ★목차는 «합집합»으로 갱신한다 — 그 사이 상대가 push 한 섹션을 지우지 않기 위해서다.
      const merged = mergeSections(existing.sections, sections);
      const patch = { sections: merged, updatedAt: new Date() };
      if (name && name !== existing.name) patch.name = name;
      if (body.actorId) patch.ownerActorId = body.actorId;
      await projects.updateOne({ collabId: existing.collabId }, { $set: patch });
      return json(res, 200, {
        ok: true,
        collabId: existing.collabId,
        seq: existing.seq,
        created: false,
        // ★서버가 아는 목차를 «돌려준다» — 앱이 seq 를 보고 「아직 안 올린 섹션」을 가려낸다.
        //   (seq:0 = 방에는 등록됐지만 내용이 한 번도 안 올라간 섹션)
        sections: merged,
      });
    }

    const now = new Date();
    const collabId = newId('cb');
    const fresh = sections.map((s) => ({
      sectionId: s.sectionId, pageId: s.pageId, hash: s.hash, seq: 0,
    }));
    await projects.insertOne({
      collabId,
      ownerEmail: user.email,
      ownerActorId: body.actorId || null,
      localProjectId,
      name: name || '이름 없는 프로젝트',
      members: [user.email],          // ★소유자도 «멤버»다 — 권한 확인이 members 하나만 보면 되게
      seq: 0,
      patchFloorSeq: 1,               // 아직 아무것도 안 잘렸다 = 1번 패치부터 살아있다
      sections: fresh,                // 목차만. 내용은 push 가 나른다.
      presence: {},
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });

    return json(res, 200, { ok: true, collabId, seq: 0, created: true, sections: fresh });
  } catch (err) {
    console.error('[collab/register] error', err);
    return json(res, 500, { ok: false, reason: 'internal_error' });
  }
};
