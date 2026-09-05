/* POST /api/license/profile-complete — 「추가정보」 화면이 저장하는 곳.
 *
 * ★왜 signup.js 를 재사용하지 않나
 *   signup.js 는 «계정을 만드는» 문이다. 구글로 들어온 사람은 계정이 «이미» 있고
 *   비밀번호가 없다 — signup 에 태우면 password 필수 검사에 걸리고,
 *   통과시키려고 그 검사를 무르면 «비밀번호 없이 가입되는 문»이 열린다.
 *   ⇒ 별도의 문을 낸다. 이 문은 «이미 로그인한 사람»만 지난다(sessionToken).
 *
 * ★현빈 결정(2026-09-06, a안) = 추가정보는 «필수»다.
 *   구글은 휴대전화를 주지 않고 약관 동의도 우리가 받아야 한다. 여기서 안 받으면
 *   «연락처 없는 회원»이 쌓이는데, 그건 나중에 못 메운다 — 연락 수단이 이메일뿐인데
 *   그 사람은 마케팅 수신에 동의한 적이 없기 때문이다.
 *
 * ⛔이 문으로 plan·accessUntil·role 을 «절대» 받지 마라. 사용자가 보내는 값이다.
 */
const { getDb } = require('../_lib/mongo');
const { findUserBySession } = require('../_lib/sessions');
const { json, handlePreflight, readJsonBody, normalizePhone } = require('../_lib/util');

const LEGAL_VERSION = process.env.LEGAL_VERSION || '1';

/* signup.js 의 buildProfile/buildConsents 와 «같은 모양»으로 만든다.
 * ⚠️두 경로가 다른 모양을 저장하면, 나중에 profile 을 읽는 쪽이 둘 다 알아야 한다. */
function buildProfile(raw) {
  const s = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
  const phone = normalizePhone(raw && raw.phone);
  const name = s(raw && raw.name, 40);
  if (!name || !phone) return null;
  return { name, phone, phoneVerified: false };
}

function buildConsents(raw, now) {
  const c = (raw && typeof raw === 'object') ? raw : {};
  const mark = (v) => ({ agreed: v === true, at: v === true ? now : null });
  return {
    docVersion: LEGAL_VERSION,
    terms: mark(c.terms),
    privacy: mark(c.privacy),
    marketing: mark(c.marketing),
  };
}

module.exports = async (req, res) => {
  if (handlePreflight(req, res)) return;
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });

  let body;
  try { body = await readJsonBody(req); }
  catch (err) { return json(res, 400, { error: 'invalid_body', detail: err.message }); }

  const sessionToken = typeof body.sessionToken === 'string' ? body.sessionToken.trim() : '';
  if (!sessionToken) return json(res, 401, { ok: false, reason: 'invalid_session' });

  const consents = body.consents;
  const consentOf = (k) => !!(consents && typeof consents === 'object' && consents[k] === true);

  /* ★signup.js 와 «같은 규칙» — 빠뜨린 동의는 «거부»와 같이 다룬다.
     그리고 이용약관 동의와 개인정보 수집·이용 동의는 «따로» 받는다
     (개인정보 보호법 제22조① 구분 동의). 하나로 묶으면 요건을 못 채운다. */
  if (!consentOf('terms')) {
    return json(res, 400, { error: 'terms_required', detail: '이용약관 동의가 필요합니다' });
  }
  if (!consentOf('privacy')) {
    return json(res, 400, { error: 'privacy_consent_required', detail: '개인정보 수집·이용에 동의해 주세요' });
  }

  const profile = buildProfile(body.profile);
  if (!profile) {
    return json(res, 400, { error: 'profile_required', detail: '이름과 휴대전화를 모두 입력해 주세요' });
  }

  try {
    const db = await getDb();
    const user = await findUserBySession(db, sessionToken);
    if (!user) return json(res, 401, { ok: false, reason: 'invalid_session' });

    const now = new Date();
    /* ★이미 profile 이 있는 사람이 이 문을 또 두드리면 «덮어쓴다» — 그건 맞다.
       이 문은 «본인이 로그인한 상태»에서만 열리고, 자기 연락처를 고치는 건 정상 동작이다.
       ⛔단 email·passwordHash·plan 은 이 문에서 «건드리지 않는다». */
    await db.collection('users').updateOne(
      { email: user.email },
      { $set: { profile, consents: buildConsents(consents, now), updatedAt: now } },
    );

    return json(res, 200, { ok: true, email: user.email });
  } catch (err) {
    console.error('[profile-complete] error', err && err.message);
    return json(res, 500, { error: 'internal_error' });
  }
};
