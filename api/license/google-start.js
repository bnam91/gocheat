/* GET /api/license/google-start — 구글 동의 화면으로 보내는 «출발점».
 *
 * 입력(쿼리)  app=web|goditor|godiv   redirect=<돌아갈 곳>
 * 출력         302 → accounts.google.com
 *
 * ★여기서 «목적지 검사»를 «먼저» 한다. state 에 담기 전에 거른다.
 *   담고 나서 콜백에서만 검사하면, 그 사이 우리가 「검증 안 된 목적지가 든 서명값」을
 *   외부에 내보낸 상태가 된다. 서명은 그 값을 «우리 것»으로 만들어 주기 때문에 위험하다.
 *
 * ⛔prompt=consent 를 붙이지 마라. 매번 동의 화면을 다시 띄워서, 재방문 로그인이
 *   「가입할 때처럼」 무거워진다. 우리는 refresh_token 이 필요 없다(1회 조회로 끝난다).
 */
const { json, handlePreflight } = require('../_lib/util');
const state = require('../_lib/oauth-state');
const allow = require('../_lib/redirect-allow');

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';

/* 콜백 주소는 «구글 콘솔에 등록된 것과 글자 하나까지 같아야» 한다.
 * ★Cloudflare 뒤라 req.headers.host 를 그대로 믿지 않는다 — 프록시가 넣어주는 값이고,
 *   틀리면 redirect_uri_mismatch 로 «전부» 실패한다. 환경변수를 «우선»으로 둔다.
 *   (signup.js 가 인증메일 링크에서 LICENSE_BASE_URL 을 같은 이유로 쓴다) */
function callbackUrl(req) {
  const base = process.env.LICENSE_BASE_URL || `https://${req.headers.host || 'blacksheepwall.kr'}`;
  return base.replace(/\/$/, '') + '/api/license/google-callback';
}

module.exports = (req, res) => {
  if (handlePreflight(req, res, { methods: 'GET, OPTIONS' })) return;
  if (req.method !== 'GET') return json(res, 405, { error: 'method_not_allowed' });

  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) return json(res, 500, { error: 'google_not_configured' });

  const url = new URL(req.url, 'http://localhost');
  const app = (url.searchParams.get('app') || 'web').trim().toLowerCase();
  const redirect = url.searchParams.get('redirect') || '';

  // ★거부가 기본 — 통과한 «정규화된 값»만 state 에 담는다(원문이 아니라).
  const chk = allow.check(app, redirect);
  if (!chk.ok) return json(res, 400, { error: 'redirect_not_allowed', detail: chk.reason || app });

  let signed;
  try { signed = state.issue({ app, redirect: chk.value }); }
  catch (e) { return json(res, 500, { error: 'state_secret_missing' }); }

  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: callbackUrl(req),
    response_type: 'code',
    // ★openid 를 넣어야 sub 가 안정적으로 온다. email·profile 은 민감 범위가 아니라 심사가 없다.
    scope: 'openid email profile',
    state: signed,
    // 계정을 여러 개 쓰는 사람이 «어느 계정인지» 고를 수 있게 한다.
    prompt: 'select_account',
  });

  res.writeHead(302, {
    Location: `${AUTH_URL}?${q.toString()}`,
    // ⛔이 응답은 절대 캐시되면 안 된다 — state 가 든 URL 이다.
    'Cache-Control': 'no-store',
  });
  res.end();
};
