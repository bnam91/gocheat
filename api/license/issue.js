const bcrypt = require('bcryptjs');
const { getDb } = require('../_lib/mongo');
const {
  json, handlePreflight, readJsonBody,
  isValidEmail, normalizeEmail,
} = require('../_lib/util');
const { makeLicenseKey } = require('../_lib/crypto');
const { findUserBySession } = require('../_lib/sessions');
const { enqueueMail, buildLicenseMail } = require('../_lib/mail');

module.exports = async (req, res) => {
  if (handlePreflight(req, res)) return;
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });

  let body;
  try { body = await readJsonBody(req); }
  catch (err) { return json(res, 400, { error: 'invalid_body', detail: err.message }); }

  const email = normalizeEmail(body.email);
  const password = body.password;
  /* ★★2026-09-06 구글 로그인 — sessionToken 도 «받는다»(additive).
   *   구글로 가입한 사람은 passwordHash 가 «없어서» 아래 bcrypt 검사를 통과할 방법이 자체가 없다.
   *   그러면 라이선스를 영원히 못 받는다 — 게다가 401 이라 «조용히» 막힌다.
   *   ⛔기존 비밀번호 경로는 «그대로» 둔다. 앱 구버전이 그 경로로 들어온다. */
  const sessionToken = typeof body.sessionToken === 'string' ? body.sessionToken.trim() : '';

  // ★login.js 와 같은 이유 — password 가 문자열이 아니면 bcrypt 로 넘기기 «전»에 끊는다.
  //   한쪽만 막으면 다른 엔드포인트로 같은 가입-여부 오라클이 샌다.
  if (!sessionToken && (!isValidEmail(email) || typeof password !== 'string' || !password)) {
    return json(res, 400, { error: 'invalid_credentials' });
  }

  try {
    const db = await getDb();
    const users = db.collection('users');
    const licenses = db.collection('licenses');

    /* ★신원 확인은 «둘 중 하나»면 된다 — 세션 토큰, 또는 이메일+비밀번호.
     *   토큰을 «먼저» 본다: 토큰이 온 요청은 앱이 이미 로그인한 상태라 그게 더 강한 증거다.
     *   ⛔둘 다 «실패 응답을 같게» 유지한다(invalid_credentials) — 다르면 그 차이가
     *     「이 이메일이 가입돼 있는가」를 알려주는 오라클이 된다(login.js·signup.js 와 같은 규칙). */
    let user = null;
    if (sessionToken) {
      user = await findUserBySession(db, sessionToken);
      // 이메일을 «같이» 보냈으면 짝이 맞는지 본다(session.js 와 같은 규칙).
      if (user && email && isValidEmail(email) && user.email !== email) user = null;
    } else {
      user = await users.findOne({ email });
      if (user && !(await bcrypt.compare(password, user.passwordHash || ''))) user = null;
    }
    if (!user) return json(res, 401, { error: 'invalid_credentials' });

    if (!user.verified) return json(res, 403, { error: 'email_not_verified' });

    /* ★★여기서부터는 body 의 email 이 아니라 «user.email» 을 쓴다.
     *   토큰으로 들어온 요청은 email 을 «안 보낼 수도» 있다. 그대로 두면
     *   licenses.userEmail 이 빈 문자열로 저장되어 «주인 없는 라이선스»가 생기고,
     *   안내 메일도 빈 주소로 나간다. 신원이 확정된 뒤엔 «확정된 값»만 쓴다. */
    const owner = user.email;

    const existingActive = await licenses.findOne({ userEmail: owner, status: 'active' });
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
          userEmail: owner,
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
      ...buildLicenseMail({ to: owner, licenseKey }),
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
