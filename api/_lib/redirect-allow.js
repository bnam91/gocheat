/* 로그인 결과(세션 토큰)를 «어디로 돌려줘도 되는가».
 *
 * ★★이 파일이 이 기능에서 가장 위험한 곳이다.
 *   콜백이 끝나면 우리는 «유효한 세션 토큰»을 손에 쥐고 그걸 어딘가로 보낸다.
 *   목적지를 요청자가 정하게 두면, 공격자는 자기 주소를 넣은 링크를 피해자에게 눌리게 해서
 *   «피해자의 토큰»을 자기 서버로 받는다. 로그인 페이지 하나로 계정이 통째로 넘어간다.
 *   ⇒ 그래서 「거부가 기본」이다. 아래 표에 «명시된 모양»만 통과한다.
 *
 * ⛔새 목적지를 추가할 때 정규식으로 «부분 일치»를 쓰지 마라.
 *   `startsWith('https://blacksheepwall.kr')` 같은 검사는
 *   `https://blacksheepwall.kr.evil.com` 을 통과시킨다. 반드시 URL 로 «파싱해서 host 를 통째로» 비교한다.
 */

/* 웹은 «호스트를 아예 못 정한다» — 경로만 받는다.
 * 그래서 웹 경로는 검사할 것이 「/ 로 시작하는가」와 「// 가 아닌가」 둘뿐이다.
 * ★`//evil.com` 은 브라우저가 «프로토콜 상대 URL»로 읽어 외부로 나간다. 이게 가장 흔한 우회다. */
function checkWebPath(redirect) {
  if (!redirect) return { ok: true, value: '/' };            // 안 주면 홈
  if (typeof redirect !== 'string' || redirect.length > 512) return { ok: false };
  if (!redirect.startsWith('/')) return { ok: false };        // 절대 URL 금지
  if (redirect.startsWith('//')) return { ok: false };        // 프로토콜 상대 URL 금지
  if (redirect.includes('\\')) return { ok: false };          // 역슬래시로 //를 흉내내는 우회
  if (/[\r\n]/.test(redirect)) return { ok: false };          // 헤더 인젝션
  return { ok: true, value: redirect };
}

/* 고디터(Electron) — RFC 8252 루프백.
 * ★포트는 앱이 «매번 새로» 연다. 그래서 포트는 못 박지 못하고 «호스트»만 못 박는다.
 *   127.0.0.1 과 [::1] 만. ⛔`localhost` 는 받지 않는다 — DNS 로 다른 곳을 가리키게 만들 수 있다. */
function checkLoopback(redirect) {
  let u;
  try { u = new URL(redirect); } catch (e) { return { ok: false }; }
  if (u.protocol !== 'http:') return { ok: false };
  /* ★URL 의 hostname 은 IPv6 를 «대괄호째» 돌려준다 — `[::1]` 이지 `::1` 이 아니다.
     이걸 모르고 '::1' 로 비교하면 «허용해야 할 것이 막힌다»(2026-09-06 검사에서 잡혔다).
     ⚠️여기서 대괄호를 벗겨 «넓게» 받으려는 유혹이 있는데, 그러면 다른 IPv6 주소도 같이 들어온다.
       루프백은 이 둘뿐이므로 «문자열 두 개»로 못 박는 게 맞다. */
  if (u.hostname !== '127.0.0.1' && u.hostname !== '[::1]') return { ok: false };
  if (!u.port) return { ok: false };                          // 포트를 반드시 명시하게 한다
  return { ok: true, value: u.toString() };
}

/* 고디브(크롬 확장) — chrome.identity.launchWebAuthFlow 가 주는 고정 주소.
 * `https://<확장ID>.chromiumapp.org/...` 이고 확장 ID 는 32자 소문자다.
 * ★★확장 ID 를 «환경변수로 못 박는다». 안 박으면 «아무 확장»이나 우리 토큰을 받아갈 수 있다.
 *   GODIV_EXTENSION_ID 가 비어 있으면 이 경로는 «통째로 닫힌다» — 열린 채로 두는 것보다 낫다. */
function checkExtension(redirect) {
  const id = (process.env.GODIV_EXTENSION_ID || '').trim();
  if (!/^[a-p]{32}$/.test(id)) return { ok: false, reason: 'extension_id_not_configured' };
  let u;
  try { u = new URL(redirect); } catch (e) { return { ok: false }; }
  if (u.protocol !== 'https:') return { ok: false };
  if (u.hostname !== `${id}.chromiumapp.org`) return { ok: false };
  return { ok: true, value: u.toString() };
}

/* app 별로 «다른 규칙»을 태운다. 모르는 app 은 거부한다(기본이 거부다). */
function check(app, redirect) {
  switch (app) {
    case 'web':     return checkWebPath(redirect);
    case 'goditor': return checkLoopback(redirect);
    case 'godiv':   return checkExtension(redirect);
    default:        return { ok: false, reason: 'unknown_app' };
  }
}

module.exports = { check, checkWebPath, checkLoopback, checkExtension };
