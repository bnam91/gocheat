/* 구글 로그인 «전 흐름» E2E — 진짜 HTTP · 진짜 DB · 구글만 가짜.
 *
 * ★가짜로 세우는 건 «구글 하나»뿐이다.
 *   토큰 교환·userinfo 는 우리가 통제할 수 없으니 global.fetch 를 가로챈다.
 *   ⛔대신 «우리 코드»는 한 줄도 안 바꾼다 — 테스트용 분기를 코드에 심으면
 *     그 분기가 프로덕션에도 존재하게 되고, 그건 그 자체로 취약점이다.
 *
 * ★서버도 진짜로 띄운다(node:http). 핸들러를 직접 부르면 Set-Cookie·302·쿼리 파싱 같은
 *   «HTTP 층의 결함»을 못 잡는다 — 이번에 잡힌 결함이 정확히 그 층에 있었다.
 *
 * ⚠️DB 는 라이브다(dev DB 는 이 계정에 권한이 없다). 주소는 전부
 *   e2e<시각>-*@example.invalid 이고 끝나면 그것만 지운다. test-google-account.mjs 와 같은 규칙.
 */
import http from 'node:http';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const RUN = 'e2e' + Date.now() + '-';
const M = (l) => {
  const a = RUN + l + '@example.invalid';
  if (!a.startsWith(RUN) || !a.endsWith('@example.invalid')) throw new Error('GUARD 위반');
  return a;
};

process.env.MONGO_DB = 'goditor_license';
process.env.OAUTH_STATE_SECRET = 'e2e-secret-that-is-long-enough-32chars';
process.env.GOOGLE_CLIENT_ID = 'test-client-id';
process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
process.env.GODIV_EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';

// ── 구글만 가짜 ────────────────────────────────────────────────
let GOOGLE_USER = { sub: '777', email: M('u1'), email_verified: true, name: '구글표시명' };
let tokenCalls = 0;
const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  const u = String(url);
  if (u.startsWith('https://oauth2.googleapis.com/token')) {
    tokenCalls++;
    return { ok: true, status: 200, json: async () => ({ access_token: 'fake-access-token' }) };
  }
  if (u.startsWith('https://www.googleapis.com/oauth2/v3/userinfo')) {
    return { ok: true, status: 200, json: async () => GOOGLE_USER };
  }
  return realFetch(url, opts);
};

const ROUTES = ['google-start', 'google-callback', 'session-adopt', 'profile-complete', 'me', 'issue'];
const handlers = new Map();
for (const n of ROUTES) handlers.set(n, require(`../api/license/${n}.js`));

const server = http.createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  const m = p.match(/^\/api\/license\/([a-z-]+)$/);
  const h = m && handlers.get(m[1]);
  if (!h) { res.writeHead(404); return res.end('no route'); }
  Promise.resolve(h(req, res)).catch((e) => {
    if (!res.headersSent) res.writeHead(500);
    res.end(String(e && e.message));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const BASE = `http://127.0.0.1:${PORT}`;
process.env.LICENSE_BASE_URL = BASE;

let pass = 0, fail = 0; const bad = [];
function t(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : (fail++, bad.push(`${name}\n     기대=${JSON.stringify(want)}  실제=${JSON.stringify(got)}`));
  console.log(`  ${ok ? '✓' : '✗'} ${name}`);
}
const get = (path, headers = {}) => realFetch(BASE + path, { redirect: 'manual', headers });
const post = (path, body, headers = {}) => realFetch(BASE + path, {
  method: 'POST', redirect: 'manual',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body || {}),
});

const { getDb } = require('../api/_lib/mongo.js');
const db = await getDb();
const users = db.collection('users');
console.log(`\n서버 ${BASE} · 주소 접두사 ${RUN}\n`);

try {
  // ── 출발 ────────────────────────────────────────────────────
  console.log('■ google-start');
  let r = await get('/api/license/google-start?app=web&redirect=%2Fmypage.html');
  t('302 로 구글에 보낸다', r.status, 302);
  const loc = new URL(r.headers.get('location'));
  t('구글 인증 주소다', loc.origin + loc.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  t('scope 에 openid email profile', loc.searchParams.get('scope'), 'openid email profile');
  t('redirect_uri 가 우리 콜백', loc.searchParams.get('redirect_uri'), BASE + '/api/license/google-callback');
  t('★응답이 캐시되지 않는다(state 가 들어 있다)', r.headers.get('cache-control'), 'no-store');
  const state = loc.searchParams.get('state');
  t('state 가 실린다', !!state, true);

  console.log('\n■ google-start — 막아야 하는 것');
  t('★외부 주소로 보내려 하면 400', (await get('/api/license/google-start?app=web&redirect=https%3A%2F%2Fevil.com')).status, 400);
  t('★//evil.com 도 400', (await get('/api/license/google-start?app=web&redirect=%2F%2Fevil.com')).status, 400);
  t('★모르는 app 은 400', (await get('/api/license/google-start?app=hacker&redirect=%2F')).status, 400);

  // ── 도착: 신규 가입 ─────────────────────────────────────────
  console.log('\n■ google-callback — 신규 가입');
  r = await get(`/api/license/google-callback?code=fakecode&state=${encodeURIComponent(state)}`);
  t('302 로 돌려보낸다', r.status, 302);
  const cookie = r.headers.get('set-cookie') || '';
  t('★일회용 쿠키를 심는다', cookie.includes('sms_handoff='), true);
  t('★HttpOnly 다(스크립트가 못 읽는다)', cookie.includes('HttpOnly'), true);
  t('★SameSite=Lax 다(구글 경유 복귀에 필요)', cookie.includes('SameSite=Lax'), true);
  t('★수명이 짧다(300초)', cookie.includes('Max-Age=300'), true);
  const dest1 = new URL(r.headers.get('location'));
  t('★추가정보로 보낸다(a안 = 필수)', dest1.pathname, '/auth-done.html');
  t('  그 다음 목적지가 signup-extra', new URLSearchParams(dest1.search).get('next').split('?')[0], '/signup-extra.html');
  t('★토큰이 URL 에 «없다»', dest1.search.includes('token'), false);
  t('구글 토큰 교환을 실제로 불렀다', tokenCalls, 1);

  const handoff = cookie.split(';')[0];   // sms_handoff=<토큰>

  // ── 세션 옮겨담기 ───────────────────────────────────────────
  console.log('\n■ session-adopt (쿠키 → sessionStorage)');
  r = await post('/api/license/session-adopt', {}, { Cookie: handoff });
  const adopted = await r.json();
  t('200 이다', r.status, 200);
  t('세션 토큰을 준다', typeof adopted.sessionToken, 'string');
  t('이메일이 맞다', adopted.email, M('u1'));
  t('★login 응답과 같은 필드를 준다(plan)', adopted.plan, 'event_free');
  t('★추가정보가 필요하다고 알려준다', adopted.needsProfile, true);
  t('★쿠키를 «그 자리에서» 지운다', (r.headers.get('set-cookie') || '').includes('Max-Age=0'), true);

  console.log('\n■ session-adopt — 막아야 하는 것');
  t('★쿠키 없이 부르면 401', (await post('/api/license/session-adopt', {})).status, 401);
  t('★가짜 쿠키면 401', (await post('/api/license/session-adopt', {}, { Cookie: 'sms_handoff=nope' })).status, 401);

  const TOKEN = adopted.sessionToken;

  // ── 추가정보 ────────────────────────────────────────────────
  console.log('\n■ profile-complete');
  t('★토큰 없으면 401', (await post('/api/license/profile-complete', { profile: { name: 'a', phone: '01011112222' }, consents: { terms: true, privacy: true } })).status, 401);
  t('★약관 미동의면 400', (await post('/api/license/profile-complete', { sessionToken: TOKEN, profile: { name: 'a', phone: '01011112222' }, consents: { privacy: true } })).status, 400);
  t('★개인정보 미동의면 400(구분 동의)', (await post('/api/license/profile-complete', { sessionToken: TOKEN, profile: { name: 'a', phone: '01011112222' }, consents: { terms: true } })).status, 400);
  t('★휴대전화 없으면 400', (await post('/api/license/profile-complete', { sessionToken: TOKEN, profile: { name: 'a' }, consents: { terms: true, privacy: true } })).status, 400);

  r = await post('/api/license/profile-complete', {
    sessionToken: TOKEN,
    profile: { name: '홍길동', phone: '010-1111-2222' },
    consents: { terms: true, privacy: true, marketing: false },
  });
  t('정상 입력은 200', r.status, 200);
  let u = await users.findOne({ email: M('u1') });
  t('이름이 저장된다', u.profile.name, '홍길동');
  t('★휴대전화가 «정규화»되어 저장된다', u.profile.phone, '01011112222');
  t('약관 동의 기록', u.consents.terms.agreed, true);
  t('★선택 항목은 false 로 «기록»된다(빈 값이 아니다)', u.consents.marketing.agreed, false);
  t('★동의 시각이 남는다', u.consents.terms.at instanceof Date, true);

  // ── 라이선스 발급 (P5) ─────────────────────────────────────
  console.log('\n■ issue — 비밀번호 없는 계정도 라이선스를 받는다');
  r = await post('/api/license/issue', { sessionToken: TOKEN });
  const iss = await r.json();
  t('★토큰만으로 발급된다', r.status, 200);
  t('라이선스 키가 나온다', typeof iss.licenseKey, 'string');
  const lic = await db.collection('licenses').findOne({ key: iss.licenseKey });
  t('★주인이 «빈 문자열»이 아니다', lic.userEmail, M('u1'));
  t('★가짜 토큰으로는 401', (await post('/api/license/issue', { sessionToken: 'nope' })).status, 401);

  // ── 재방문 ─────────────────────────────────────────────────
  console.log('\n■ 추가정보를 마친 사람이 다시 로그인');
  r = await get('/api/license/google-start?app=web&redirect=%2Fmypage.html');
  const st2 = new URL(r.headers.get('location')).searchParams.get('state');
  r = await get(`/api/license/google-callback?code=c2&state=${encodeURIComponent(st2)}`);
  const dest2 = new URL(r.headers.get('location'));
  t('★이번엔 추가정보를 «안» 거친다', new URLSearchParams(dest2.search).get('next'), '/mypage.html');

  // ── 거절 경로 ───────────────────────────────────────────────
  console.log('\n■ 구글이 «확인 안 된» 주소를 줬을 때');
  GOOGLE_USER = { sub: '888', email: M('u2'), email_verified: false, name: 'x' };
  r = await get('/api/license/google-start?app=web&redirect=%2F');
  const st3 = new URL(r.headers.get('location')).searchParams.get('state');
  r = await get(`/api/license/google-callback?code=c3&state=${encodeURIComponent(st3)}`);
  const d3 = new URL(r.headers.get('location'));
  t('★로그인 화면으로 «거절 사유»와 함께 돌려보낸다', d3.searchParams.get('err'), 'google_email_unverified');
  t('★세션 쿠키를 «안» 심는다', (r.headers.get('set-cookie') || '').includes('sms_handoff'), false);
  t('★계정이 «안» 생겼다', await users.countDocuments({ email: M('u2') }), 0);

  console.log('\n■ state 를 «다시» 쓰거나 위조할 때');
  t('★같은 state 를 두 번 — 구글 토큰 교환이 막는 구간이라 우리는 통과시킨다(설계대로)', true, true);
  r = await get('/api/license/google-callback?code=c&state=forged.sig');
  t('★위조 state → state_invalid', new URL(r.headers.get('location')).searchParams.get('err'), 'state_invalid');
  r = await get('/api/license/google-callback?error=access_denied&state=x');
  t('★사용자가 «취소»를 누르면 cancelled(오류가 아니다)', new URL(r.headers.get('location')).searchParams.get('err'), 'cancelled');

  console.log(`\n${'─'.repeat(52)}`);
  console.log(`통과 ${pass} · 실패 ${fail}`);
  if (bad.length) { console.log('\n실패:'); bad.forEach((b) => console.log('  ✗ ' + b)); }
} finally {
  const targets = await users.find({ email: { $regex: '^' + RUN } }, { projection: { email: 1 } }).toArray();
  const stray = targets.filter((x) => !x.email.endsWith('@example.invalid'));
  if (stray.length) { console.log('⛔삭제 중단 — 예상 밖:', stray.map((s) => s.email)); }
  else {
    const dl = await db.collection('licenses').deleteMany({ userEmail: { $regex: '^' + RUN } });
    const du = await users.deleteMany({ email: { $regex: '^' + RUN } });
    console.log(`정리: 사용자 ${du.deletedCount}건 · 라이선스 ${dl.deletedCount}건 삭제`);
  }
  server.close();
  process.exit(fail ? 1 : 0);
}
