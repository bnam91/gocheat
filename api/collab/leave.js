const { getDb } = require('../_lib/mongo');
const { json, handlePreflight, readJsonBody } = require('../_lib/util');
const {
  authenticate, unauthorized, notFound, loadProject,
} = require('../_lib/collab');

/* 협업에서 빠진다.
 *
 * 입력  { sessionToken, collabId, action?: 'disband' }
 * 출력  { ok, left | disbanded }
 *
 * ★소유자는 «나갈» 수 없다 — 주인 없는 방이 남으면 아무도 초대·해산을 못 한다.
 *   소유자에게 있는 선택지는 «해산(disband)»이다. 명시적으로 action:'disband' 를 보내야 한다.
 *   나가기 버튼 하나가 상대의 협업까지 통째로 날려버리면 안 되므로 «다른 말»을 요구한다.
 *
 * ★해산해도 사람들의 «로컬 프로젝트»는 그대로다. 없어지는 건 원격 방과 패치뿐이다.
 *   그래서 해산은 파괴적이지 않다 — 확인 절차를 서버가 더 두지 않는다(앱이 물어본다).
 */
module.exports = async (req, res) => {
  if (handlePreflight(req, res, { origin: '*' })) return;
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });
  res.setHeader('Access-Control-Allow-Origin', '*');

  let body;
  try { body = await readJsonBody(req); }
  catch (err) { return json(res, 400, { error: 'invalid_body', detail: err.message }); }

  try {
    const db = await getDb();
    const user = await authenticate(db, body.sessionToken);
    if (!user) return unauthorized(res);

    const project = await loadProject(db, body.collabId, user.email);
    if (!project) return notFound(res);

    const projects = db.collection('collab_projects');
    const isOwner = project.ownerEmail === user.email;

    if (isOwner) {
      if (body.action !== 'disband') {
        return json(res, 400, {
          ok: false, reason: 'owner_cannot_leave', hint: "action:'disband' 로 해산할 수 있다",
        });
      }
      await projects.updateOne({ collabId: project.collabId }, {
        $set: {
          status: 'disbanded', members: [], presence: {}, disbandedAt: new Date(), updatedAt: new Date(),
        },
      });
      // 방이 없어졌으니 배지가 계속 뜨면 안 된다 — 안 받은 초대를 닫는다.
      await db.collection('collab_invites').updateMany(
        { collabId: project.collabId, status: 'pending' },
        { $set: { status: 'revoked', respondedAt: new Date() } },
      );
      // 패치는 즉시 지운다. 방이 없으면 아무도 못 읽고, 남겨두면 TTL 7일까지 용량만 문다.
      await db.collection('collab_patches').deleteMany({ collabId: project.collabId });
      return json(res, 200, { ok: true, disbanded: true });
    }

    // 나간 사람이 「편집 중」으로 상대 화면에 계속 떠 있으면 안 된다 — presence 항목도 걷어낸다.
    const stalePresence = Object.keys(project.presence || {})
      .filter((actorId) => (project.presence[actorId] || {}).email === user.email);
    await projects.updateOne({ collabId: project.collabId }, {
      $pull: { members: user.email },
      $set: { updatedAt: new Date() },
      // ⚠️빈 $unset 은 Mongo 가 거절한다 — 지울 게 없으면 연산자 자체를 빼야 한다
      ...(stalePresence.length
        ? { $unset: Object.fromEntries(stalePresence.map((a) => [`presence.${a}`, ''])) }
        : {}),
    });
    // 다시 초대받을 수 있어야 하므로 남은 pending 초대는 닫아둔다(중복 방어와 짝).
    await db.collection('collab_invites').updateMany(
      { collabId: project.collabId, email: user.email, status: 'pending' },
      { $set: { status: 'revoked', respondedAt: new Date() } },
    );

    return json(res, 200, { ok: true, left: true });
  } catch (err) {
    console.error('[collab/leave] error', err);
    return json(res, 500, { ok: false, reason: 'internal_error' });
  }
};
