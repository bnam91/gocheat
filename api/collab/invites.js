const { getDb } = require('../_lib/mongo');
const { json, handlePreflight, readJsonBody } = require('../_lib/util');
const { authenticate, unauthorized, presenceList } = require('../_lib/collab');

/* 내가 받은 pending 초대 + 내가 들어가 있는 프로젝트 목록.
 *
 * 입력  { sessionToken }
 * 출력  { ok, invites:[...], projects:[...] }
 *
 * ⛔★«읽기 전용»이다. 이 파일에 쓰기를 추가하지 마라 — session.js 와 같은 이유다.
 *   앱 탑바 배지가 이걸 2초마다 부른다. 여기서 뭘 하나라도 쓰면 초당 수십 번의 쓰기가 되고,
 *   그때부터 앱은 이걸 마음 편히 부를 수 없게 된다. 기록이 필요하면 «다른» 엔드포인트를 만들어라.
 *   (presence 갱신은 pull 이 한다 — pull 요청 자체가 하트비트다.)
 *
 * ★snapshot 은 «절대» 여기 싣지 않는다. 2초 폴링에 MB 짜리를 매번 태우게 된다.
 *   합류자의 초기 상태는 pull(sinceSeq=0) 이 한 번만 준다.
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

    const [invites, projects] = await Promise.all([
      db.collection('collab_invites')
        .find({ email: user.email, status: 'pending' })
        .sort({ createdAt: -1 }).limit(50).toArray(),
      db.collection('collab_projects')
        .find(
          { members: user.email, status: 'active' },
          // ★projection 으로 snapshot 을 «잘라낸다». 안 그러면 2초마다 프로젝트 전체가 날아온다.
          { projection: { snapshot: 0 } },
        )
        .sort({ updatedAt: -1 }).limit(100).toArray(),
    ]);

    const now = Date.now();
    return json(res, 200, {
      ok: true,
      invites: invites.map((iv) => ({
        inviteId: iv.inviteId,
        collabId: iv.collabId,
        projectName: iv.projectName,
        invitedBy: iv.invitedBy,
        createdAt: iv.createdAt,
      })),
      projects: projects.map((p) => ({
        collabId: p.collabId,
        name: p.name,
        seq: p.seq,
        owner: p.ownerEmail,
        isOwner: p.ownerEmail === user.email,
        members: p.members,
        // 로컬 프로젝트와 이어붙이려면 앱이 «자기가 올린 것»의 로컬 id 를 알아야 한다.
        // 남의 프로젝트의 로컬 id 는 내 쪽에서 쓸모가 없고, 남의 파일 구조를 흘리는 셈이라 빼고 준다.
        localProjectId: p.ownerEmail === user.email ? p.localProjectId : null,
        online: presenceList(p, now),
        updatedAt: p.updatedAt,
      })),
    });
  } catch (err) {
    console.error('[collab/invites] error', err);
    return json(res, 500, { ok: false, reason: 'internal_error' });
  }
};
