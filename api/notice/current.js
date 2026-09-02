/* GET /api/notice/current — «지금 이 사람에게 보여줄» 공지 1건.
 *
 * ★폴링이다. 푸시가 아니다(PLAN §1). 앱이 시작할 때와 N시간마다 묻는다.
 *   ⇒ 이 엔드포인트는 «자주» 불린다. DB 질의는 인덱스(startAt·endAt) 안에서 끝나야 한다.
 *
 * 입력(쿼리)  app · appVersion · plan · seen(콤마로 이은 id 목록)
 *   ⛔sessionToken 을 쿼리에 싣지 마라 — nginx 액세스로그에 그대로 남는다.
 *     등급을 «서버가 확인»하고 싶으면 x-session-token 헤더로 보내라(그건 로그에 안 남는다).
 *
 * ★seen 을 받는 이유
 *   읽음 기록은 앱의 파일에 있다(현빈 확정: userData 파일). 서버가 그걸 모르면 «이미 읽은 공지»를
 *   계속 1순위로 돌려주고, 그 뒤에 있는 «아직 안 읽은» 공지가 영원히 안 뜬다.
 *   ⇒ 읽은 id 를 보내면 서버가 그걸 빼고 다음 것을 준다. 안 보내도 동작한다(그땐 최상위 1건).
 *
 * ★D-b(기간이 전송 중에 끝남)에 대한 서버의 답
 *   ① 만료된 공지는 «절대» 내보내지 않는다(질의 조건이 now 하나로 고정 — 요청 안에서 시각이 흔들리지 않는다).
 *   ② 그래도 응답이 도착했을 땐 이미 지났을 수 있다 ⇒ endAt 과 serverNow 를 «같이» 준다.
 *      앱은 endAt <= serverNow 면 띄우지 않고, 떠 있는 중이면 닫는다. 판정 기준을 기기 시계에 맡기지 않는다.
 */
const { getDb } = require('../_lib/mongo');
const { json } = require('../_lib/util');
const { getQuery, handlePreflightAuth, setCorsAuth, sessionTokenFromHeader } = require('../_lib/http-extra');
const { findUserBySession } = require('../_lib/roles');
const { matchesTarget, pickOne, publicShape } = require('../_lib/notice-lib');

const MAX_SEEN = 50;      // 읽음 목록이 무한히 커져 URL 을 밀어내지 않게

module.exports = async (req, res) => {
  if (handlePreflightAuth(req, res, 'GET, OPTIONS')) return;
  setCorsAuth(res, 'GET, OPTIONS');
  // ★캐시 금지 — 공지는 «지금» 상태다. 중간 캐시가 끝난 공지를 되살리면 안 된다.
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET' && req.method !== 'POST') {
    return json(res, 405, { ok: false, error: 'method_not_allowed' });
  }

  const q = getQuery(req);
  const seen = String(q.seen || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, MAX_SEEN);

  try {
    const db = await getDb();
    const now = new Date();          // ★요청당 «한 번». 아래 판정이 전부 이 시각을 쓴다.

    let plan = typeof q.plan === 'string' ? q.plan : '';
    // 헤더로 토큰을 주면 등급을 «서버가» 확인한다(쿼리의 plan 은 클라이언트가 하는 말이라 사칭 가능).
    const token = sessionTokenFromHeader(req);
    if (token) {
      const user = await findUserBySession(db, token);
      if (user) plan = user.plan || plan;
    }

    const ctx = {
      app: q.app || 'goditor',
      appVersion: q.appVersion || q.version || '',
      plan,
    };

    const rows = await db.collection('notices').find({
      revoked: { $ne: true },
      startAt: { $lte: now },
      endAt: { $gte: now },
    }).sort({ startAt: -1 }).limit(50).toArray();

    const eligible = rows.filter((n) => !seen.includes(String(n._id)) && matchesTarget(n, ctx));
    const picked = pickOne(eligible);

    return json(res, 200, {
      ok: true,
      notice: publicShape(picked),
      // ★기기 시계를 믿지 않기 위한 기준점. 앱은 endAt 을 이 값과 견준다.
      serverNow: now.toISOString(),
    });
  } catch (err) {
    console.error('[notice/current] error', err && err.message);
    // ⛔공지 조회 실패로 앱이 멈추면 안 된다 — 앱은 notice:null 과 같게 다뤄야 한다.
    return json(res, 500, { ok: false, error: 'internal_error', notice: null });
  }
};
