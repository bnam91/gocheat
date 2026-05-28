const bcrypt = require('bcryptjs');
const { getDb } = require('../_lib/mongo');
const {
  json, handlePreflight, readJsonBody,
  isValidEmail, normalizeEmail, isStrongEnough,
} = require('../_lib/util');
const { randomToken } = require('../_lib/crypto');
const { enqueueMail, buildVerifyMail } = require('../_lib/mail');

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

module.exports = async (req, res) => {
  if (handlePreflight(req, res)) return;
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });

  let body;
  try { body = await readJsonBody(req); }
  catch (err) { return json(res, 400, { error: 'invalid_body', detail: err.message }); }

  const email = normalizeEmail(body.email);
  const password = body.password;

  if (!isValidEmail(email)) return json(res, 400, { error: 'invalid_email' });
  if (!isStrongEnough(password)) return json(res, 400, { error: 'weak_password', detail: 'min 8 chars' });

  try {
    const db = await getDb();
    const users = db.collection('users');
    const now = new Date();

    const existing = await users.findOne({ email });
    if (existing && existing.verified) {
      return json(res, 200, { ok: true, email, alreadyVerified: true });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const verificationToken = randomToken(32);
    const verificationTokenExpiresAt = new Date(now.getTime() + TOKEN_TTL_MS);

    await users.updateOne(
      { email },
      {
        $set: {
          email,
          passwordHash,
          verified: false,
          verifiedAt: null,
          verificationToken,
          verificationTokenExpiresAt,
          updatedAt: now,
        },
        $setOnInsert: { createdAt: now },
      },
      { upsert: true },
    );

    const base = process.env.LICENSE_BASE_URL || `https://${req.headers.host || 'hompageapp.vercel.app'}`;
    const verifyUrl = `${base.replace(/\/$/, '')}/api/license/verify?token=${verificationToken}`;

    await enqueueMail({
      ...buildVerifyMail({ to: email, verifyUrl }),
      idempotencyKey: `verify:${email}:${verificationToken}`,
    });

    return json(res, 200, { ok: true, email, pendingVerification: true });
  } catch (err) {
    console.error('[signup] error', err);
    return json(res, 500, { error: 'internal_error' });
  }
};
