const bcrypt = require('bcryptjs');
const { getDb } = require('../_lib/mongo');
const {
  json, handlePreflight, readJsonBody,
  isValidEmail, normalizeEmail, isStrongEnough,
} = require('../_lib/util');
const { randomToken } = require('../_lib/crypto');
const { emailDomainAcceptsMail } = require('../_lib/mx');
const { enqueueMail, buildVerifyMail } = require('../_lib/mail');


// ★개인정보는 profile 한 덩어리로 «묶어서» 저장한다.
//   흩뿌려 두면 나중에 탈퇴·파기할 때 어느 필드가 개인정보인지 매번 세어야 한다.
//   묶어두면 삭제가 { $unset: { profile: '' } } 한 줄이다.
// ★동의는 «언제·무엇에» 했는지가 남아야 의미가 있다. boolean 하나로는 증빙이 안 된다.
function buildProfile(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const s = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
  const phone = s(raw.phone, 20).replace(/[^0-9]/g, '');
  const name = s(raw.name, 40);
  if (!name && !phone) return null;
  return {
    name, phone,
    // 휴대전화는 아직 «인증되지 않은» 값이다. 나중에 인증이 붙어도
    // 이 플래그만 보면 어느 번호가 검증된 것인지 구분된다.
    phoneVerified: false,
  };
}

// ★★동의는 «무엇에» 했는지가 «문서 버전»까지 남아야 증빙이 된다.
//   boolean + 시각만으로는 방침을 한 번 고치는 순간 「이 사람이 본 문서」를 재구성할 수 없다.
// ★그리고 이용약관 동의와 개인정보 수집·이용 동의는 «따로» 받는다 — 하나로 묶으면
//   개인정보 보호법 제22조① 의 «구분 동의» 요건을 못 채운다. (2026-09-02)
//   ⚠️ 옛 폼(구버전 탭)은 privacy 를 안 보낸다. 그래서 «없으면 없는 대로» 기록하고,
//      막는 건 아래 검사에서 «명시적으로» 한다 — 조용히 true 로 채우지 않는다.
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

// ★배포 분리 스위치. 클라이언트(signup.html)와 «같은 파일»을 본다.
//   env 로 갈라 두면 둘이 어긋나 «폼은 안 물어보는데 서버는 받는» 상태가 생긴다.
//   레포 파일이라 정적 require 로 번들에 실린다 — 켜고 끄는 건 커밋 한 줄이다.
const FLAGS = require('../../data/flags.json');
const EXTENDED_SIGNUP = FLAGS.extendedSignup === true;

// ★동의 레코드에 박아 둘 «고지 문서 버전». data/legal.json 을 고칠 때 version 을 올리면
//   그 이후 가입자는 새 버전으로 기록된다 — 옛 동의는 옛 버전으로 남는다.
const LEGAL_VERSION = (require('../../data/legal.json').version || 'unknown');

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

  // ★★메일이 «도달할 수 있는 도메인»인지 확인한다(현빈 2026-09-02).
  //   화면(중복확인)에서도 막지만 여기서 한 번 더 본다 — 화면을 우회해 직접 요청을 보내면
  //   그대로 계정이 만들어진다. 실제로 2026-09-02 에 'gmail.comㄴㅇ' 로 계정이 생겼다.
  //   ★DNS 가 답을 못 주면 통과시킨다(mx.js) — 우리 사정으로 가입을 막지 않는다.
  const mxOk = await emailDomainAcceptsMail(email);
  if (!mxOk.ok) {
    return json(res, 400, { error: 'undeliverable_domain',
      detail: '메일을 받을 수 없는 주소예요. 도메인을 다시 확인해 주세요.' });
  }

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
    return json(res, 400, { error: 'terms_required', detail: '이용약관 동의가 필요합니다' });
  }
  // ★개인정보를 «받는» 요청이면 개인정보 수집·이용 동의가 따로 있어야 한다.
  //   약관 동의로 갈음하지 않는다(제22조① 구분 동의).
  if (profile && consents && consents.privacy !== true) {
    // ★이 오류를 볼 «유일한» 사람은 배포 «전»에 열어둔 탭을 쓰는 사용자다 —
    //   그 폼에는 개인정보 동의 칸이 아예 «없어서» 「동의해 달라」는 말이 통하지 않는다.
    //   그래서 문구가 «할 수 있는 행동»을 말해야 한다.
    return json(res, 400, {
      error: 'privacy_consent_required',
      detail: '페이지를 새로고침한 뒤 개인정보 수집·이용에 동의해 주세요.',
    });
  }

  try {
    const db = await getDb();
    const users = db.collection('users');
    const now = new Date();

    const existing = await users.findOne({ email });

    const passwordHash = await bcrypt.hash(password, 10);
    const verificationToken = randomToken(32);
    const verificationTokenExpiresAt = new Date(now.getTime() + TOKEN_TTL_MS);

    // ★★가입은 «만들기»지 «덮어쓰기»가 아니다.
    //   전에는 계정 전체를 $set 으로 덮었다. 그래서 «미인증 계정»에 다른 비밀번호로
    //   다시 가입하면 passwordHash 가 갈렸다. 거기서 탈취가 완성된다:
    //     ① 피해자 가입(미인증) → ② 공격자가 같은 이메일로 재가입해 비밀번호를 갈아치움
    //     → ③ 새 인증링크가 «피해자 메일함»으로 감 → ④ 피해자가 자기 메일인 줄 알고 누름
    //     → verified:true 인데 비밀번호는 공격자 것 → ⑤ 공격자 로그인
    //   ★마지막 칸을 피해자 «본인의 클릭»이 채운다. 공격자는 메일함 접근이 필요 없다.
    //   지금은 EVENT_MODE 가 켜져 있어 안 터지지만, 이벤트 종료로 off 가 되는 순간 열린다.
    //
    //   ⇒ 자격증명과 신원은 «만들 때만» 쓴다($setOnInsert). 기존 문서는 건드리지 않는다.
    //     비밀번호를 바꾸는 길은 «비밀번호 찾기»뿐이어야 한다.
    const setOnInsert = {
      email,
      passwordHash,
      createdAt: now,
      plan: 'event_free',
      accessUntil: EVENT_UNTIL,
      verified: EVENT_MODE ? true : false,
      verifiedAt: EVENT_MODE ? now : null,
      ...(profile ? { profile } : {}),
      ...(consents ? { consents: buildConsents(consents, now) } : {}),
    };

    // 기존 문서에 손대도 되는 건 «인증 링크» 하나뿐이다 — 그것도 아직 미인증일 때만.
    // 링크를 새로 줘도 그 링크가 인증하는 건 «원래 주인의 비밀번호»라 안전하다.
    // ⚠️ 다만 이 경로로 남의 메일함에 인증메일을 반복 발송할 수는 있다(스팸).
    //    호출 빈도 제한은 아직 없다 — 메일이 실제로 나가기 전에 붙여야 한다.
    const set = { updatedAt: now };
    const needsVerifyLink = !EVENT_MODE && !(existing && existing.verified);
    if (needsVerifyLink) {
      set.verificationToken = verificationToken;
      set.verificationTokenExpiresAt = verificationTokenExpiresAt;
    }

    await users.updateOne({ email }, { $set: set, $setOnInsert: setOnInsert }, { upsert: true });

    // ★2026-08-18 도메인 통일(현빈 승인): Host 헤더가 없을 때의 «최후» 폴백도 라이브(blacksheepwall.kr)로.
    //   평소엔 req.headers.host 가 잡히므로 이 값이 쓰일 일은 드물지만, 쓰이는 그 순간은
    //   «인증메일 링크»라 사용자가 직접 클릭한다 — 개발용 주소가 메일로 나가면 안 된다.
    const base = process.env.LICENSE_BASE_URL || `https://${req.headers.host || 'blacksheepwall.kr'}`;
    const verifyUrl = `${base.replace(/\/$/, '')}/api/license/verify?token=${verificationToken}`;

    // ★★응답은 «계정이 있든 없든 똑같다». 다르면 그 자체가 계정 열거 도구가 된다.
    //   전에는 이미 가입된 이메일에 alreadyVerified:true 를 돌려줬다 — 아무나 이메일을
    //   넣어보고 «이 사람이 가입했는지»를 알아낼 수 있었다. find-email 에서 주소를
    //   fi*****@ 로 가린 것과 같은 이유다. 가리는 곳과 흘리는 곳이 따로 있으면 소용없다.
    if (EVENT_MODE) {
      // ★이벤트 기간: 보내지도 못할 인증메일을 큐에 쌓지 않는다. 가입 즉시 사용 가능.
      return json(res, 200, { ok: true, email, ready: true, plan: 'event_free', accessUntil: EVENT_UNTIL });
    }

    // 인증 링크가 필요한 계정에만 메일을 보낸다. 이미 인증된 계정이면 아무것도 안 보내되,
    // 응답은 «위와 같다» — 안 보냈다는 사실이 밖으로 드러나면 안 된다.
    // ⚠️ TODO(메일 가동 후): 이미 가입된 주소에는 «누군가 이 이메일로 가입을 시도했습니다.
    //    이미 계정이 있으니 로그인하거나 비밀번호를 재설정하세요» 메일을 보내는 게 옳다.
    //    지금은 메일 경로 자체가 이벤트 기간 동안 꺼져 있어 그 설계를 미룬다.
    if (needsVerifyLink) {
      await enqueueMail({
        ...buildVerifyMail({ to: email, verifyUrl }),
        idempotencyKey: `verify:${email}:${verificationToken}`,
      });
    }

    return json(res, 200, { ok: true, email, pendingVerification: true });
  } catch (err) {
    console.error('[signup] error', err);
    return json(res, 500, { error: 'internal_error' });
  }
};
