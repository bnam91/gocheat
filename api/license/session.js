const { getDb } = require('../_lib/mongo');
const { json, handlePreflight, readJsonBody, isValidEmail, normalizeEmail } = require('../_lib/util');

const PURCHASE_URL = process.env.PURCHASE_URL || 'https://hompageapp.vercel.app/pricing.html';

// 앱이 저장된 세션으로 접근권한을 «조용히» 갱신할 때 부르는 엔드포인트.
// 비밀번호를 받지 않는다 — 앱은 비밀번호를 보관하지 않기 때문이다.
//
// ★세션 검증은 sessionToken을 회전시키지 않는다.
//   갱신할 때마다 토큰이 바뀌면 앱이 들고 있는 캐시가 매번 어긋나 무한 재로그인이 된다.
//   토큰 회전은 login에서만 일어난다.
//
// ★만료는 에러가 아니다: HTTP 200 + {ok:false, reason:'expired'}.
//   앱(services/authService.js verifySession)은 status 200 이 아니거나 ok가 boolean이 아니면
//   «판단 불가»로 보고 로컬 캐시를 그대로 신뢰한다. 그래서 거절도 반드시 200으로 준다.
module.exports = async (req, res) => {
  if (handlePreflight(req, res, { origin: '*' })) return;
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });

  // 앱(Electron)은 브라우저 origin이 없다. 토큰 자체가 비밀이라 '*' 로 둔다 — check.js와 동일.
  res.setHeader('Access-Control-Allow-Origin', '*');

  let body;
  try { body = await readJsonBody(req); }
  catch (err) { return json(res, 400, { error: 'invalid_body', detail: err.message }); }

  const email = normalizeEmail(body.email);
  const sessionToken = typeof body.sessionToken === 'string' ? body.sessionToken.trim() : '';

  // 입력 불량도 200 + ok:false 로 준다. 400을 주면 앱이 «판단 불가»로 읽어
  // 만료된 캐시를 계속 신뢰하게 된다 — 거절이 거절로 전달되지 않는다.
  if (!isValidEmail(email) || !sessionToken) {
    return json(res, 200, { ok: false, reason: 'invalid_session' });
  }

  try {
    const db = await getDb();
    const user = await db.collection('users').findOne({ email });

    // 계정이 없거나 토큰이 다르다 = 다른 기기에서 로그인해 토큰이 회전했거나, 폐기된 세션.
    // 존재 여부를 구분해 알려주지 않는다(계정 존재 여부 노출 방지).
    if (!user || !user.sessionToken || user.sessionToken !== sessionToken) {
      return json(res, 200, { ok: false, reason: 'invalid_session' });
    }

    const until = user.accessUntil ? new Date(user.accessUntil) : null;
    const expired = until ? until.getTime() < Date.now() : false;
    const plan = user.plan || 'event_free';

    if (expired) {
      // ★막기만 하고 어디로 가라고 안 하면 사용자는 또 헤맨다 — 갈 곳을 함께 준다
      return json(res, 200, {
        ok: false,
        reason: 'expired',
        plan,
        accessUntil: until,
        purchaseUrl: PURCHASE_URL,
      });
    }

    // 갱신 성공. sessionToken은 건드리지 않는다(회전 금지).
    await db.collection('users').updateOne(
      { email },
      { $set: { lastSeenAt: new Date() } },
    );

    return json(res, 200, { ok: true, plan, accessUntil: until });
  } catch (err) {
    console.error('[session] error', err);
    // 서버 오류는 500으로 준다 — 앱이 «판단 불가»로 읽어 오프라인 유예를 유지한다.
    // 여기서 200 + ok:false 를 주면 일시적 DB 장애가 곧바로 전원 로그아웃이 된다.
    return json(res, 500, { ok: false, reason: 'internal_error' });
  }
};
