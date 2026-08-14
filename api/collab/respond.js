const { getDb } = require('../_lib/mongo');
const { json, handlePreflight, readJsonBody } = require('../_lib/util');
const {
  isInviteId, authenticate, unauthorized, notFound,
} = require('../_lib/collab');

/* 초대에 답한다.
 *
 * 입력  { sessionToken, inviteId, action: 'accept' | 'decline' }
 * 출력  { ok, collabId?, name? }
 *
 * ★«내게 온» 초대만 답할 수 있다. 남의 inviteId 를 넣으면 없는 것과 같은 404 다
 *   (초대가 실재하는지 알려주면 inviteId 를 훑어 남의 협업 존재를 캐낼 수 있다).
 */
module.exports = async (req, res) => {
  if (handlePreflight(req, res, { origin: '*' })) return;
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });
  res.setHeader('Access-Control-Allow-Origin', '*');

  let body;
  try { body = await readJsonBody(req); }
  catch (err) { return json(res, 400, { error: 'invalid_body', detail: err.message }); }

  const action = body.action === 'accept' || body.action === 'decline' ? body.action : null;
  if (!action) return json(res, 400, { ok: false, reason: 'invalid_action' });
  if (!isInviteId(body.inviteId)) return notFound(res);

  try {
    const db = await getDb();
    const user = await authenticate(db, body.sessionToken);
    if (!user) return unauthorized(res);

    const invites = db.collection('collab_invites');
    // ★status:'pending' 까지 걸어 «한 번만» 소비되게 한다.
    //   두 번 눌러도 두 번 들어가지 않는다(members 는 $addToSet 이라 어차피 안전하지만,
    //   같은 초대가 accept 후 decline 으로 뒤집히는 것도 막아야 한다).
    const invite = await invites.findOne({
      inviteId: body.inviteId, email: user.email, status: 'pending',
    });
    if (!invite) return notFound(res);

    if (action === 'decline') {
      await invites.updateOne(
        { inviteId: invite.inviteId, status: 'pending' },
        { $set: { status: 'declined', respondedAt: new Date() } },
      );
      return json(res, 200, { ok: true, declined: true });
    }

    const projects = db.collection('collab_projects');
    const project = await projects.findOne({ collabId: invite.collabId, status: 'active' });
    if (!project) {
      // 초대는 살아있는데 프로젝트가 사라졌다(해산됨) — 초대도 같이 닫는다.
      await invites.updateOne(
        { inviteId: invite.inviteId },
        { $set: { status: 'revoked', respondedAt: new Date() } },
      );
      return notFound(res);
    }

    await projects.updateOne(
      { collabId: project.collabId },
      { $addToSet: { members: user.email }, $set: { updatedAt: new Date() } },
    );
    await invites.updateOne(
      { inviteId: invite.inviteId, status: 'pending' },
      { $set: { status: 'accepted', respondedAt: new Date() } },
    );

    return json(res, 200, {
      ok: true,
      collabId: project.collabId,
      name: project.name,
      // 합류자는 여기서 받은 seq 를 sinceSeq 로 쓰지 «않는다» — 0부터 당겨야 초기 상태를 받는다.
      seq: project.seq,
    });
  } catch (err) {
    console.error('[collab/respond] error', err);
    return json(res, 500, { ok: false, reason: 'internal_error' });
  }
};
