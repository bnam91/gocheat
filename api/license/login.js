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
  if (!isValidEmail(email) || !password) return json(res, 401, { ok: false, reason: 'invalid_credentials' });

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
