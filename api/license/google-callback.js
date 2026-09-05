/* GET /api/license/google-callback — 구글이 돌려보내는 «도착점».
 *
 * 흐름  code 검증 → 토큰 교환 → 사용자 조회 → 계정 처리 → 세션 발급 → 목적지로 반환
 *
 * ★라이브러리를 쓰지 않는다.
 *   보통 여기서 id_token 의 «서명»을 검증하려고 JWKS 라이브러리를 넣는다.
 *   우리는 그 단계를 통째로 건너뛴다 — access_token 으로 userinfo 를 «우리가 직접» 부르면,
 *   그 응답은 «구글이 우리에게 TLS 로 준 것»이라 서명을 다시 볼 이유가 없다.
 *   ⇒ 의존성 0. (서버 의존성이 bcryptjs·mongodb 둘뿐인 상태를 지킨다)
 *
 * ★세션은 «기존 것»을 그대로 쓴다(issueSession). 앱별 칸·구버전 호환·원자성이 전부 승계된다.
 *   ⛔여기서 randomToken 으로 토큰을 직접 만들지 마라 — login.js 가 같은 실수로 한 번 회귀했다.
 */
const { json, handlePreflight } = require('../_lib/util');
const { getDb } = require('../_lib/mongo');
const { issueSession } = require('../_lib/sessions');
const state = require('../_lib/oauth-state');
const allow = require('../_lib/redirect-allow');
const { upsertFromGoogle } = require('../_lib/google-account');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';

function baseUrl(req) {
  const b = process.env.LICENSE_BASE_URL || `https://${req.headers.host || 'blacksheepwall.kr'}`;
  return b.replace(/\/$/, '');
}

/* 실패는 «사용자가 보는 화면»으로 돌려보낸다.
 * ★코드를 URL 로 넘기고 «문구는 로그인 페이지가» 고른다 —
 *   서버가 한국어 문장을 만들어 붙이면 문구를 고칠 때마다 서버를 배포해야 한다. */
function fail(req, res, code) {
  res.writeHead(302, { Location: `${baseUrl(req)}/login.html?err=${encodeURIComponent(code)}`, 'Cache-Control': 'no-store' });
  res.end();
}

/* 성공 — app 별로 «돌려주는 방식»이 다르다.
 *   web     : 토큰을 «URL 에 싣지 않는다». 쿠키 대신 한 번 쓰고 버리는 짧은 경로를 쓴다.
 *   goditor : 루프백 주소에 쿼리로 싣는다(그 주소는 그 PC 안에서만 열린다)
 *   godiv   : 확장 전용 주소에 쿼리로 싣는다(크롬이 그 창을 닫고 값만 확장에 준다) */
function succeed(req, res, { app, redirect, sessionToken, email, next }) {
  if (app === 'web') {
    /* ★★웹의 세션은 «sessionStorage 의 sms_token»이다(nav-auth.js 가 그걸로 판단한다).
       리디렉션 응답은 스크립트에 값을 줄 수 없으므로, 토큰을 «일회용 쿠키»로 건네고
       착지 페이지(auth-done.html)가 session-adopt 로 바꿔 담는다.
       ⛔토큰을 쿼리로 주지 않는다 — 브라우저 기록·리퍼러·프록시 로그에 남는다.

       ⚠️SameSite=Lax 여야 한다 — 구글이라는 «다른 사이트를 거쳐» 돌아오는 이동이라
         Strict 면 그 첫 요청에 쿠키가 실리지 않는다(=로그인이 통째로 안 된다).
       ★Max-Age 는 «분» 단위다. 이 쿠키는 저장소가 아니라 «건네주는 손»이라 오래 살 이유가 없다. */
    const dest = next || redirect || '/';
    const q = new URLSearchParams({ next: dest });
    res.writeHead(302, {
      'Set-Cookie': `sms_handoff=${sessionToken}; Path=/; Max-Age=300; HttpOnly; Secure; SameSite=Lax`,
      Location: baseUrl(req) + '/auth-done.html?' + q.toString(),
      'Cache-Control': 'no-store',
    });
    return res.end();
  }

  const u = new URL(redirect);
  u.searchParams.set('token', sessionToken);
  u.searchParams.set('email', email);
  if (next) u.searchParams.set('next', next);
  res.writeHead(302, { Location: u.toString(), 'Cache-Control': 'no-store' });
  res.end();
}

module.exports = async (req, res) => {
  if (handlePreflight(req, res, { methods: 'GET, OPTIONS' })) return;
  if (req.method !== 'GET') return json(res, 405, { error: 'method_not_allowed' });

  const url = new URL(req.url, 'http://localhost');

  // 사용자가 동의 화면에서 «취소»를 누르면 error=access_denied 로 돌아온다 — 오류가 아니다.
  const gErr = url.searchParams.get('error');
  if (gErr) return fail(req, res, gErr === 'access_denied' ? 'cancelled' : 'google_error');

  const code = url.searchParams.get('code');
  const rawState = url.searchParams.get('state');
  if (!code || !rawState) return fail(req, res, 'bad_request');

  const st = state.verify(rawState);
  if (!st.ok) return fail(req, res, st.reason === 'expired' ? 'state_expired' : 'state_invalid');

  /* ★목적지를 «여기서 다시» 검사한다.
     start 에서 이미 걸렀지만, 그건 「그때의 설정」으로 판단한 것이다.
     확장 ID 를 회수했거나 규칙을 좁힌 뒤라면 옛 state 가 아직 살아 있을 수 있다(최대 10분).
     서명이 맞다는 것과 «지금도 가도 되는 곳»이라는 건 다른 질문이다. */
  const chk = allow.check(st.app, st.redirect);
  if (!chk.ok) return fail(req, res, 'redirect_not_allowed');

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return fail(req, res, 'not_configured');

  try {
    // ── ① code → access_token (client_secret 은 «서버에서만» 쓴다) ──
    const tokRes = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: baseUrl(req) + '/api/license/google-callback',
        grant_type: 'authorization_code',
      }),
    });
    if (!tokRes.ok) {
      // ⛔본문을 로그에 찍지 마라 — code·토큰이 들어 있다.
      console.error('[google-callback] token exchange failed', tokRes.status);
      return fail(req, res, 'token_exchange_failed');
    }
    const tok = await tokRes.json();
    if (!tok || !tok.access_token) return fail(req, res, 'token_exchange_failed');

    // ── ② access_token → 사용자 ──
    const infoRes = await fetch(USERINFO_URL, { headers: { Authorization: `Bearer ${tok.access_token}` } });
    if (!infoRes.ok) {
      console.error('[google-callback] userinfo failed', infoRes.status);
      return fail(req, res, 'userinfo_failed');
    }
    const info = await infoRes.json();

    // ── ③ 계정 처리 (설계 §3 의 표가 여기 들어 있다) ──
    const acc = await upsertFromGoogle(info);
    if (!acc.ok) {
      // ★'google_email_unverified' 와 'account_conflict' 는 «사용자에게 다르게 말해야» 한다.
      return fail(req, res, acc.reason);
    }

    // ── ④ 세션 — 기존 함수 그대로 ──
    const db = await getDb();
    const issued = await issueSession(db, acc.email, st.app === 'web' ? 'web' : st.app);

    /* ── ⑤ 추가정보가 필요한 사람은 그리로 «먼저» 보낸다(현빈 결정: a안 = 필수) ──
       ★구글은 휴대전화를 주지 않고 약관 동의도 우리가 받아야 한다.
         여기서 통과시키면 «연락처 없는 회원»이 쌓이고, 그건 나중에 못 메운다
         (연락 수단이 이메일뿐인데 그 사람은 마케팅 수신에 동의한 적이 없다). */
    const needsExtra = acc.created || acc.needsProfile;
    const next = needsExtra
      ? '/signup-extra.html' + (st.app === 'web' && chk.value && chk.value !== '/'
          ? '?next=' + encodeURIComponent(chk.value) : '')
      : null;

    return succeed(req, res, {
      app: st.app,
      redirect: chk.value,
      sessionToken: issued.sessionToken,
      email: acc.email,
      next,
    });
  } catch (err) {
    console.error('[google-callback] error', err && err.message);
    return fail(req, res, 'internal_error');
  }
};
