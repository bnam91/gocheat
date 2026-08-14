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
 * ★목차(sections)도 여기 싣지 않는다 — 개수(sectionCount)만 준다. 2초 폴링 자리다.
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
          /* ★목차(sections)는 «내려보내지 않는다» — 개수만 센다.
           *   2초 폴링이 부르는 자리다. 섹션 수백 개짜리 프로젝트가 여럿이면 목차만으로도
           *   응답이 수십 KB 가 되고, 그걸 초당 반복하게 된다.
           *   목차 «내용»이 필요하면 pull(wantSections:true) 로 받아간다.
           * ★«쓸 것만» 적는 포함형 projection 이다. 제외형(sections:0)으로 두면
           *   나중에 큰 필드가 하나 늘 때마다 이 폴링이 조용히 무거워진다. */
          {
            projection: {
              collabId: 1, name: 1, seq: 1, ownerEmail: 1, members: 1,
              localProjectId: 1, presence: 1, updatedAt: 1,
              sectionCount: { $size: { $ifNull: ['$sections', []] } },
            },
          },
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
        sectionCount: p.sectionCount || 0,
        online: presenceList(p, now),
        updatedAt: p.updatedAt,
      })),
    });
  } catch (err) {
    console.error('[collab/invites] error', err);
    return json(res, 500, { ok: false, reason: 'internal_error' });
  }
};
