/* OAuth state — «왕복 사이에만» 사는 값이라 DB 를 쓰지 않는다.
 *
 * ★state 가 하는 일은 하나다: 「지금 돌아온 이 콜백이, 우리가 «내보낸» 그 요청이 맞는가」.
 *   맞지 않으면 남이 시작한 로그인을 우리 사용자에게 붙이는 CSRF 가 성립한다.
 *
 * ★왜 컬렉션을 새로 안 만드나
 *   state 는 «10분» 살고 «한 번» 쓰인다. 그걸 위해 컬렉션을 만들면
 *   ①TTL 인덱스 ②정리 ③레이스 를 새로 관리해야 한다. 서명이면 그 셋이 전부 사라진다.
 *   ⇒ 값을 «우리가 서명해서 내보내고, 돌아온 걸 다시 계산해» 대조한다.
 *
 * ⚠️서명은 «위조»를 막지 «재사용»을 막지 못한다. 재사용 방어는 exp(10분)와
 *   code 자체가 «구글에서 1회용»이라는 성질이 같이 맡는다. 같은 code 를 두 번 쓰면
 *   구글 토큰 교환이 invalid_grant 로 떨어진다 — 그 층이 이미 있어서 여기서 또 막지 않는다.
 *
 * ⛔이 파일에 «리디렉션 허용 판정»을 넣지 마라. 그건 redirect-allow.js 가 한다.
 *   서명은 「우리가 만든 값인가」만 답하고, 「그 값이 가도 되는 곳인가」는 별개 질문이다.
 *   한 함수가 둘 다 하면, 서명만 통과시키고 목적지 검사를 빠뜨린 경로가 생긴다.
 */
const crypto = require('crypto');

// 10분. 사람이 구글 동의 화면에서 계정을 고르고 2단계 인증까지 하는 시간을 덮되,
// 그 이상 열어 둘 이유가 없다.
const TTL_MS = 10 * 60 * 1000;

/* ★비밀이 없으면 «조용히 약한 키로 돌지» 않는다 — 죽는다.
 *   랜덤 폴백을 두면 프로세스가 재시작될 때마다 키가 바뀌어, 진행 중이던 로그인이
 *   전부 「위조된 state」로 떨어진다. 그 증상은 «간헐적»이라 원인 추적이 가장 어렵다. */
function secret() {
  const s = process.env.OAUTH_STATE_SECRET;
  if (!s || s.length < 32) {
    throw new Error('OAUTH_STATE_SECRET 미설정(또는 32자 미만) — /etc/goditor-api/env 를 확인하세요');
  }
  return s;
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function sign(payloadB64) {
  return crypto.createHmac('sha256', secret()).update(payloadB64).digest('base64url');
}

/* 발급 — { app, redirect } 를 봉해서 문자열 하나로 만든다.
 * nonce 는 «같은 입력이라도 매번 다른 state 가 나오게» 한다(로그·이력에서 재사용 방지). */
function issue({ app, redirect }) {
  const payload = {
    app: String(app || 'web'),
    redirect: String(redirect || ''),
    nonce: crypto.randomBytes(12).toString('base64url'),
    exp: Date.now() + TTL_MS,
  };
  const p = b64url(JSON.stringify(payload));
  return p + '.' + sign(p);
}

/* 검증 — 통과하면 { ok:true, app, redirect }, 아니면 { ok:false, reason }.
 * ⛔예외를 던지지 않는다. 콜백 핸들러가 «사용자에게 보여줄 화면»을 골라야 하는데,
 *   던지면 전부 500 한 덩어리가 되어 「만료」와 「위조」를 구분해 말할 수 없다. */
function verify(state) {
  if (typeof state !== 'string' || state.length > 4096) return { ok: false, reason: 'malformed' };
  const dot = state.lastIndexOf('.');
  if (dot <= 0) return { ok: false, reason: 'malformed' };

  const p = state.slice(0, dot);
  const sig = state.slice(dot + 1);

  let expected;
  try { expected = sign(p); }
  catch (e) { return { ok: false, reason: 'no_secret' }; }

  /* ★timingSafeEqual 은 «길이가 다르면 던진다» — 먼저 길이를 보고 걸러야 한다.
     그리고 길이 비교 자체는 타이밍 정보를 흘리지 않는다(서명 길이는 항상 같으므로,
     길이가 다르다는 건 애초에 우리 서명이 아니라는 뜻이다). */
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: 'bad_signature' };
  }

  let payload;
  try { payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')); }
  catch (e) { return { ok: false, reason: 'malformed' }; }

  // ★서명이 맞아도 «만료»는 따로 본다. 서명은 「우리가 만들었나」만 말한다.
  if (!payload || typeof payload.exp !== 'number' || payload.exp < Date.now()) {
    return { ok: false, reason: 'expired' };
  }

  return { ok: true, app: payload.app || 'web', redirect: payload.redirect || '' };
}

module.exports = { issue, verify, TTL_MS };
