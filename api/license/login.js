const bcrypt = require('bcryptjs');
const { randomToken } = require('../_lib/crypto');
const { getDb } = require('../_lib/mongo');
const { json, handlePreflight, readJsonBody, isValidEmail, normalizeEmail } = require('../_lib/util');

const PURCHASE_URL = process.env.PURCHASE_URL || 'https://hompageapp.vercel.app/pricing.html';

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

    const until = user.accessUntil ? new Date(user.accessUntil) : null;
    const expired = until ? until.getTime() < Date.now() : false;
    // ★앱이 비밀번호를 저장하면 안 된다 — 토큰만 주고 앱은 그것만 보관한다
    const sessionToken = randomToken(32);
    await db.collection('users').updateOne({ email }, {
      $set: { lastLoginAt: new Date(), sessionToken, sessionIssuedAt: new Date() },
    });

    return json(res, 200, {
      ok: !expired,
      email,
      plan: user.plan || 'event_free',
      sessionToken,
      accessUntil: until,
      // ★막기만 하고 어디로 가라고 안 하면 사용자는 또 헤맨다 — 갈 곳을 함께 준다
      ...(expired ? { reason: 'expired', purchaseUrl: PURCHASE_URL } : {}),
    });
  } catch (err) {
    console.error('[login] error', err);
    return json(res, 500, { ok: false, reason: 'internal_error' });
  }
};
