const bcrypt = require('bcryptjs');
const { getDb } = require('../_lib/mongo');
const {
  json, handlePreflight, readJsonBody,
  isValidEmail, normalizeEmail,
} = require('../_lib/util');
const { makeLicenseKey } = require('../_lib/crypto');
const { enqueueMail, buildLicenseMail } = require('../_lib/mail');

module.exports = async (req, res) => {
  if (handlePreflight(req, res)) return;
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });

  let body;
  try { body = await readJsonBody(req); }
  catch (err) { return json(res, 400, { error: 'invalid_body', detail: err.message }); }

  const email = normalizeEmail(body.email);
  const password = body.password;

  // ★login.js 와 같은 이유 — password 가 문자열이 아니면 bcrypt 로 넘기기 «전»에 끊는다.
  //   한쪽만 막으면 다른 엔드포인트로 같은 가입-여부 오라클이 샌다.
  if (!isValidEmail(email) || typeof password !== 'string' || !password) {
    return json(res, 400, { error: 'invalid_credentials' });
  }

  try {
    const db = await getDb();
    const users = db.collection('users');
    const licenses = db.collection('licenses');

    const user = await users.findOne({ email });
    if (!user) return json(res, 401, { error: 'invalid_credentials' });

    const ok = await bcrypt.compare(password, user.passwordHash || '');
    if (!ok) return json(res, 401, { error: 'invalid_credentials' });

    if (!user.verified) return json(res, 403, { error: 'email_not_verified' });

    const existingActive = await licenses.findOne({ userEmail: email, status: 'active' });
    if (existingActive) {
      return json(res, 200, {
        ok: true,
        licenseKey: existingActive.key,
        reissued: false,
        deliveredVia: 'mail_queue',
      });
    }

    const now = new Date();
    let licenseKey = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = makeLicenseKey();
      try {
        await licenses.insertOne({
          key: candidate,
          userEmail: email,
          issuedAt: now,
          machineId: null,
          status: 'active',
          updatedAt: now,
        });
        licenseKey = candidate;
        break;
      } catch (err) {
        if (err && err.code === 11000) continue;
        throw err;
      }
    }
    if (!licenseKey) return json(res, 500, { error: 'key_collision' });

    await enqueueMail({
      ...buildLicenseMail({ to: email, licenseKey }),
      idempotencyKey: `deliver:${licenseKey}`,
    });

    return json(res, 200, {
      ok: true,
      licenseKey,
      reissued: false,
      deliveredVia: 'mail_queue',
    });
  } catch (err) {
    console.error('[issue] error', err);
    return json(res, 500, { error: 'internal_error' });
  }
};
