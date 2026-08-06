const bcrypt = require('bcryptjs');
const { getDb } = require('../_lib/mongo');
const {
  json, handlePreflight, readJsonBody,
  isValidEmail, normalizeEmail, isStrongEnough,
} = require('../_lib/util');
const { randomToken } = require('../_lib/crypto');
const { enqueueMail, buildVerifyMail } = require('../_lib/mail');


// ★개인정보는 profile 한 덩어리로 «묶어서» 저장한다.
//   흩뿌려 두면 나중에 탈퇴·파기할 때 어느 필드가 개인정보인지 매번 세어야 한다.
//   묶어두면 삭제가 { $unset: { profile: '' } } 한 줄이다.
// ★동의는 «언제·무엇에» 했는지가 남아야 의미가 있다. boolean 하나로는 증빙이 안 된다.
function buildProfile(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const s = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
  const phone = s(raw.phone, 20).replace(/[^0-9]/g, '');
  const birth = s(raw.birth, 10);
  const name = s(raw.name, 40);
  if (!name && !phone && !birth) return null;
  return {
    name, phone,
    birth: /^\d{4}-\d{2}-\d{2}$/.test(birth) ? birth : '',
    // 휴대전화는 아직 «인증되지 않은» 값이다. 나중에 인증이 붙어도
    // 이 플래그만 보면 어느 번호가 검증된 것인지 구분된다.
    phoneVerified: false,
  };
}

function buildConsents(raw, now) {
  const c = (raw && typeof raw === 'object') ? raw : {};
  const out = { terms: { agreed: c.terms === true, at: c.terms === true ? now : null } };
  out.marketing = { agreed: c.marketing === true, at: c.marketing === true ? now : null };
  return out;
}

// ★배포 분리 스위치. 클라이언트(signup.html)와 «같은 파일»을 본다.
//   env 로 갈라 두면 둘이 어긋나 «폼은 안 물어보는데 서버는 받는» 상태가 생긴다.
//   레포 파일이라 정적 require 로 번들에 실린다 — 켜고 끄는 건 커밋 한 줄이다.
const FLAGS = require('../../data/flags.json');
const EXTENDED_SIGNUP = FLAGS.extendedSignup === true;

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const EVENT_MODE = process.env.EVENT_MODE !== 'off';           // 이벤트 기간엔 이메일 인증 생략
const EVENT_UNTIL = new Date(process.env.EVENT_UNTIL || '2026-12-31T23:59:59Z');

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

  // ★★확장 가입이 잠겨 있으면 개인정보를 «아예 받지 않는다».
  //   폼을 지우는 것만으로는 못 막는다 — 구버전 폼·캐시된 페이지·직접 호출이
  //   여전히 profile 을 보낸다. 막는 자리는 «저장 직전»인 여기다.
  //   잠겨 있는 이유: 개인정보 수집·이용 동의는 고지사항이 있어야 성립하는데
  //   data/legal.json 의 약관 본문이 아직 비어 있다(사업자정보 대기).
  const profile = EXTENDED_SIGNUP ? buildProfile(body.profile) : null;
  const consents = EXTENDED_SIGNUP ? body.consents : null;

  if (!EXTENDED_SIGNUP && body.profile) {
    // 조용히 버리지 않고 «버렸다»고 로그를 남긴다 — 나중에 «왜 안 저장됐지»로 헤매지 않게.
    console.warn('[signup] extendedSignup=false — 전달된 profile 을 저장하지 않고 버림');
  }

  // 필수 동의가 없으면 개인정보를 받지 않는다(확장이 열린 뒤에도 유효한 규칙).
  if (profile && consents && consents.terms !== true) {
    return json(res, 400, { error: 'terms_required', detail: '이용약관·개인정보 처리방침 동의가 필요합니다' });
  }

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
          verified: EVENT_MODE ? true : false,
          verifiedAt: EVENT_MODE ? now : null,
          accessUntil: EVENT_UNTIL,
          plan: 'event_free',
          verificationToken,
          verificationTokenExpiresAt,
          updatedAt: now,
          ...(profile ? { profile } : {}),
          ...(consents ? { consents: buildConsents(consents, now) } : {}),
        },
        $setOnInsert: { createdAt: now },
      },
      { upsert: true },
    );

    const base = process.env.LICENSE_BASE_URL || `https://${req.headers.host || 'hompageapp.vercel.app'}`;
    const verifyUrl = `${base.replace(/\/$/, '')}/api/license/verify?token=${verificationToken}`;

    if (EVENT_MODE) {
      // ★이벤트 기간: 보내지도 못할 인증메일을 큐에 쌓지 않는다. 가입 즉시 사용 가능.
      return json(res, 200, { ok: true, email, ready: true, plan: 'event_free', accessUntil: EVENT_UNTIL });
    }

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
