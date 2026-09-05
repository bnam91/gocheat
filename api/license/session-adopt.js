/* POST /api/license/session-adopt — 구글 콜백이 심어 둔 «일회용 쿠키»를 세션 토큰으로 바꿔 준다.
 *
 * ★★왜 이 문이 필요한가 (2026-09-06 적대적 검수에서 잡힌 결함)
 *   이 사이트의 웹 세션은 «sessionStorage 의 sms_token»이다(nav-auth.js 가 그걸로 로그인 여부를 판단).
 *   그런데 OAuth 콜백은 «리디렉션»이라 응답 본문을 스크립트에 줄 수 없다 — 심을 수 있는 건 쿠키뿐이다.
 *   그리고 서버에는 쿠키를 읽는 코드가 «하나도 없었다». 그대로 두면
 *     ①추가정보 화면이 401 로 튕기고 ②상단바가 계속 「로그인」으로 남는다.
 *
 *   ⇒ 쿠키를 «최종 저장소»가 아니라 «건네주는 손»으로만 쓴다.
 *     이 문이 쿠키를 읽어 토큰을 돌려주고 «그 자리에서 쿠키를 지운다».
 *     그 뒤 웹은 지금까지와 «완전히 같은» sessionStorage 체계로 돈다.
 *
 * ★토큰을 URL 로 넘기지 않는 이유 — 브라우저 기록·리퍼러·프록시 로그에 남는다.
 *   쿠키는 수명이 «몇 분»이고 HttpOnly 라 스크립트가 못 읽는다.
 *
 * ⛔이 문을 「아무 때나 세션을 꺼내는 문」으로 키우지 마라. 하는 일은 «한 번 옮기고 지우는 것»뿐이다.
 */
const { getDb } = require('../_lib/mongo');
const { findUserBySession } = require('../_lib/sessions');
const { json, handlePreflight } = require('../_lib/util');
const { roleForResponse } = require('../_lib/roles');

const COOKIE = 'sms_handoff';

/* ★쿠키 파싱을 라이브러리 없이 한다(의존성 0 원칙).
   ⚠️값에 '=' 가 들어갈 수 있으므로 «첫 번째» '=' 로만 자른다. */
function readCookie(header, name) {
  if (typeof header !== 'string') return '';
  const parts = header.split(';');
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i].trim();
    const eq = p.indexOf('=');
    if (eq > 0 && p.slice(0, eq) === name) return decodeURIComponent(p.slice(eq + 1));
  }
  return '';
}

// 지울 때도 «심을 때와 같은 속성»이어야 브라우저가 같은 쿠키로 인식한다.
const CLEAR = `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;

module.exports = async (req, res) => {
  if (handlePreflight(req, res)) return;
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });

  const token = readCookie(req.headers.cookie, COOKIE);
  if (!token) return json(res, 401, { ok: false, reason: 'no_handoff' });

  try {
    const db = await getDb();
    const user = await findUserBySession(db, token);
    // ★쿠키가 유효하든 아니든 «지운다». 실패한 쿠키를 남겨 두면 계속 재시도된다.
    res.setHeader('Set-Cookie', CLEAR);
    if (!user) return json(res, 401, { ok: false, reason: 'invalid_session' });

    /* ★login.js 응답과 «같은 모양»으로 돌려준다.
       착지 페이지가 login-page.js 와 똑같이 sessionStorage 를 채울 수 있어야
       두 로그인 경로가 «같은 상태»를 만든다(한쪽만 plan 을 빠뜨리면 화면이 갈린다). */
    const until = user.accessUntil ? new Date(user.accessUntil) : null;
    return json(res, 200, {
      ok: true,
      email: user.email,
      sessionToken: token,
      plan: user.plan || 'event_free',
      accessUntil: until,
      role: roleForResponse(user),
      // 추가정보가 아직 비어 있는지 — 착지 페이지가 어디로 보낼지 정하는 데 쓴다.
      needsProfile: !user.profile,
      name: (user.profile && user.profile.name) || '',
    });
  } catch (err) {
    console.error('[session-adopt] error', err && err.message);
    return json(res, 500, { error: 'internal_error' });
  }
};
