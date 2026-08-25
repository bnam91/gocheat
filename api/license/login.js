const bcrypt = require('bcryptjs');
const { getDb } = require('../_lib/mongo');
const { issueSession } = require('../_lib/sessions');
const { entitlementsForResponse, effectiveFor } = require('../_lib/entitlements');
const { json, handlePreflight, readJsonBody, isValidEmail, normalizeEmail } = require('../_lib/util');

// ★2026-08-18 도메인 통일(현빈 승인): 라이브 = blacksheepwall.kr(EC2). 옛 vercel.app 은 개발용으로 내려간다.
//   ⇒ env PURCHASE_URL 이 없을 때 사용자를 «개발용 사이트»로 보내지 않도록 기본값을 옮긴다.
const PURCHASE_URL = process.env.PURCHASE_URL || 'https://blacksheepwall.kr/pricing.html';

// 앱(고디터)이 부르는 유일한 인증 엔드포인트. 라이선스 키를 대체한다.
module.exports = async (req, res) => {
  if (handlePreflight(req, res, { origin: '*' })) return;
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });

  let body;
  try { body = await readJsonBody(req); }
  catch (err) { return json(res, 400, { error: 'invalid_body', detail: err.message }); }

  const email = normalizeEmail(body.email);
  const password = body.password;
  // ★password 는 «문자열»만 받는다. 객체({$ne:...} 등)가 그대로 bcrypt.compare 로 넘어가면
  //   존재하는 계정에서만 던져 500 이 나고, 없는 계정은 401 이라 「가입 여부」가 새어 나갔다.
  //   여기서 문자열이 아니면 DB 조회 «전»에 401 로 끊어, 있는 계정·없는 계정이 «같은» 응답을 낸다.
  //   (email 은 normalizeEmail→isValidEmail 이 이미 문자열로 강제하므로 안전)
  if (!isValidEmail(email) || typeof password !== 'string' || !password) {
    return json(res, 401, { ok: false, reason: 'invalid_credentials' });
  }

  try {
    const db = await getDb();
    const user = await db.collection('users').findOne({ email });
    if (!user) return json(res, 401, { ok: false, reason: 'invalid_credentials' });
    if (!(await bcrypt.compare(password, user.passwordHash || ''))) {
      return json(res, 401, { ok: false, reason: 'invalid_credentials' });
    }
    if (!user.verified) return json(res, 403, { ok: false, reason: 'email_not_verified' });

    // ★2026-08-25 ③-1: 만료를 «이 로그인의 앱» 기준으로 판정한다(effectiveFor). entitlements.<app>.until 우선,
    //   없으면 전역 accessUntil 폴백. until:null = 무기한. 'web'·미지정 app 은 정규화에서 null→전역 폴백(안전).
    const eff = effectiveFor(user, body.app);
    const until = eff.until ? new Date(eff.until) : null;
    const expired = until ? until.getTime() < Date.now() : false;
    // ★앱이 비밀번호를 저장하면 안 된다 — 토큰만 주고 앱은 그것만 보관한다
    // ★2026-08-25: 토큰을 «제품별 칸»에 넣는다(_lib/sessions.js).
    //   전엔 한 칸이라 홈페이지에 로그인하면 크롬 확장이 튕겼다 — 사용자는 이유를 모르는 로그아웃이었다.
    //   app 을 안 보내는 옛 클라이언트는 'legacy' 칸을 공유한다(지금과 동일 — 나빠지지 않는다).
    const { sessionToken, app } = await issueSession(db, email, body.app);

    return json(res, 200, {
      ok: !expired,
      email,
      plan: user.plan || 'event_free',
      sessionToken,
      // ★어느 칸에 넣었는지 돌려준다 — 클라이언트가 app 을 «보냈다고 믿는» 것과 서버 판단이 어긋나면
      //   여기서 드러난다(오타로 legacy 칸에 들어가 놓고 자기 칸인 줄 아는 사고를 막는다).
      app,
      accessUntil: until,
      // ★2026-08-25 additive: 앱별 자격을 «추가 필드»로 싣는다. 기존 plan/accessUntil 은 그대로 둔다
      //   (옛 앱은 그걸 읽는다 — 빼거나 개명하면 깨진다). 새 앱은 entitlements.<app> 를 본다.
      entitlements: entitlementsForResponse(user),
      // ★막기만 하고 어디로 가라고 안 하면 사용자는 또 헤맨다 — 갈 곳을 함께 준다
      ...(expired ? { reason: 'expired', purchaseUrl: PURCHASE_URL } : {}),
    });
  } catch (err) {
    console.error('[login] error', err);
    return json(res, 500, { ok: false, reason: 'internal_error' });
  }
};
