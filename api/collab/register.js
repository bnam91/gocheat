const { getDb } = require('../_lib/mongo');
const { json, handlePreflight, readJsonBody } = require('../_lib/util');
const {
  MAX_PAYLOAD_CHARS, newId, authenticate, unauthorized, tooLarge, jsonSize,
} = require('../_lib/collab');

/* 로컬 프로젝트를 «원격으로 올린다» — 협업의 시작점.
 *
 * 입력  { sessionToken, localProjectId, name, snapshot? }
 * 출력  { ok, collabId, seq, created }
 *
 * ★멱등이다. 같은 사람이 같은 localProjectId 로 다시 부르면 «기존 것»을 돌려준다.
 *   앱은 재시작·재로그인마다 이걸 부를 수 있어야 한다. 부를 때마다 새 방이 생기면
 *   화면엔 유령 프로젝트가 쌓이고 상대는 어느 방에 있는지 알 수 없게 된다.
 *
 * ★snapshot 은 «선택»이다. 있으면 나중에 합류한 사람의 초기 상태로 쓰인다(pull sinceSeq=0).
 *   없어도 등록은 된다 — 대신 합류자는 A 가 섹션을 한 번씩 push 해줄 때까지 빈 화면을 본다.
 *   ⚠️캔버스에 base64 이미지가 박히면 snapshot 이 MB 단위로 뛴다. 한도를 넘으면 413 이다
 *     (섹션 단위 push 로 나눠 올리는 게 정답이다 — 한 방에 밀어넣는 경로를 만들지 않았다).
 */
module.exports = async (req, res) => {
  if (handlePreflight(req, res, { origin: '*' })) return;
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });
  res.setHeader('Access-Control-Allow-Origin', '*');

  let body;
  try { body = await readJsonBody(req); }
  catch (err) {
    // readJsonBody 는 1MB 를 넘으면 던진다 — 400(형식 오류)이 아니라 413(크기)으로 갈라 말한다
    if (/too large/i.test(err.message)) return tooLarge(res, { limit: MAX_PAYLOAD_CHARS });
    return json(res, 400, { error: 'invalid_body', detail: err.message });
  }

  const localProjectId = typeof body.localProjectId === 'string' ? body.localProjectId.trim() : '';
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 200) : '';
  if (!localProjectId || localProjectId.length > 200) {
    return json(res, 400, { ok: false, reason: 'invalid_local_project_id' });
  }

  const hasSnapshot = body.snapshot !== undefined && body.snapshot !== null;
  if (hasSnapshot) {
    const size = jsonSize(body.snapshot);
    if (size > MAX_PAYLOAD_CHARS) {
      return tooLarge(res, { limit: MAX_PAYLOAD_CHARS, actual: size, field: 'snapshot' });
    }
  }

  try {
    const db = await getDb();
    const user = await authenticate(db, body.sessionToken);
    if (!user) return unauthorized(res);

    const projects = db.collection('collab_projects');
    const existing = await projects.findOne({
      ownerEmail: user.email, localProjectId, status: 'active',
    });
    if (existing) {
      // 이름·스냅샷만 최신으로 덮는다. seq/members/patches 는 «절대» 건드리지 않는다.
      const patch = {};
      if (name && name !== existing.name) patch.name = name;
      if (hasSnapshot) { patch.snapshot = body.snapshot; patch.snapshotSeq = existing.seq; }
      if (Object.keys(patch).length) {
        patch.updatedAt = new Date();
        await projects.updateOne({ collabId: existing.collabId }, { $set: patch });
      }
      return json(res, 200, {
        ok: true, collabId: existing.collabId, seq: existing.seq, created: false,
      });
    }

    const now = new Date();
    const collabId = newId('cb');
    await projects.insertOne({
      collabId,
      ownerEmail: user.email,
      localProjectId,
      name: name || '이름 없는 프로젝트',
      members: [user.email],          // ★소유자도 «멤버»다 — 권한 확인이 members 하나만 보면 되게
      seq: 0,
      patchFloorSeq: 1,               // 아직 아무것도 안 잘렸다 = 1번 패치부터 살아있다
      snapshot: hasSnapshot ? body.snapshot : null,
      snapshotSeq: 0,
      presence: {},
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });

    return json(res, 200, { ok: true, collabId, seq: 0, created: true });
  } catch (err) {
    console.error('[collab/register] error', err);
    return json(res, 500, { ok: false, reason: 'internal_error' });
  }
};
