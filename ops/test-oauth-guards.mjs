/* state 서명·리디렉션 허용목록 «적대적» 검사.
 *
 * ★목적은 「도는가」가 아니라 «막아야 할 것을 실제로 막는가»다.
 *   그래서 절반 이상이 «통과하면 안 되는» 입력이다.
 *   DB 를 안 쓴다 — 두 모듈이 순수 함수라 그대로 부를 수 있다.
 *
 * 실행: node ops/test-oauth-guards.mjs
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

process.env.OAUTH_STATE_SECRET = 'test-secret-that-is-long-enough-32chars!!';
process.env.GODIV_EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';

const state = require('../api/_lib/oauth-state.js');
const allow = require('../api/_lib/redirect-allow.js');

let pass = 0, fail = 0;
const bad = [];
function t(name, got, want) {
  const ok = got === want;
  ok ? pass++ : (fail++, bad.push(`${name}\n     기대=${want}  실제=${got}`));
  console.log(`  ${ok ? '✓' : '✗'} ${name}`);
}

console.log('\n■ state — 정상');
const good = state.issue({ app: 'web', redirect: '/mypage.html' });
t('발급한 state 는 통과한다', state.verify(good).ok, true);
t('app 이 그대로 돌아온다', state.verify(good).app, 'web');
t('redirect 가 그대로 돌아온다', state.verify(good).redirect, '/mypage.html');
t('같은 입력이라도 매번 다른 값이다', state.issue({ app: 'web', redirect: '/' }) === state.issue({ app: 'web', redirect: '/' }), false);

console.log('\n■ state — 막아야 하는 것');
t('서명 한 글자 변조 → 거부', state.verify(good.slice(0, -1) + (good.slice(-1) === 'A' ? 'B' : 'A')).reason, 'bad_signature');
t('payload 변조(서명 그대로) → 거부', (() => {
  const dot = good.lastIndexOf('.');
  const p = JSON.parse(Buffer.from(good.slice(0, dot), 'base64url').toString());
  p.redirect = 'https://evil.com';
  const forged = Buffer.from(JSON.stringify(p)).toString('base64url');
  return state.verify(forged + '.' + good.slice(dot + 1)).reason;
})(), 'bad_signature');
t('서명 없음 → 거부', state.verify('justpayload').reason, 'malformed');
t('빈 문자열 → 거부', state.verify('').reason, 'malformed');
t('숫자 등 비문자열 → 거부', state.verify(12345).reason, 'malformed');
t('4KB 초과 → 거부', state.verify('a'.repeat(5000) + '.sig').reason, 'malformed');
t('만료된 state → 거부', (() => {
  const p = Buffer.from(JSON.stringify({ app: 'web', redirect: '/', nonce: 'x', exp: Date.now() - 1000 })).toString('base64url');
  const crypto = require('crypto');
  const sig = crypto.createHmac('sha256', process.env.OAUTH_STATE_SECRET).update(p).digest('base64url');
  return state.verify(p + '.' + sig).reason;
})(), 'expired');
t('다른 비밀로 서명한 값 → 거부', (() => {
  const p = Buffer.from(JSON.stringify({ app: 'web', redirect: '/', nonce: 'x', exp: Date.now() + 60000 })).toString('base64url');
  const crypto = require('crypto');
  const sig = crypto.createHmac('sha256', 'attacker-secret-attacker-secret!').update(p).digest('base64url');
  return state.verify(p + '.' + sig).reason;
})(), 'bad_signature');

console.log('\n■ 리디렉션 — web (경로만 허용)');
t('빈 값 → 홈', allow.check('web', '').value, '/');
t('정상 경로 통과', allow.check('web', '/mypage.html').ok, true);
t('쿼리 붙은 경로 통과', allow.check('web', '/goditor.html#pricing').ok, true);
t('★//evil.com 차단(프로토콜 상대)', allow.check('web', '//evil.com').ok, false);
t('★절대 URL 차단', allow.check('web', 'https://evil.com/x').ok, false);
t('★역슬래시 우회 차단', allow.check('web', '/\\evil.com').ok, false);
t('★개행(헤더 인젝션) 차단', allow.check('web', '/a\r\nLocation: https://evil.com').ok, false);
t('★javascript: 차단', allow.check('web', 'javascript:alert(1)').ok, false);
t('512자 초과 차단', allow.check('web', '/' + 'a'.repeat(600)).ok, false);

console.log('\n■ 리디렉션 — goditor (루프백만)');
t('127.0.0.1 + 포트 통과', allow.check('goditor', 'http://127.0.0.1:51234/cb').ok, true);
t('[::1] + 포트 통과', allow.check('goditor', 'http://[::1]:51234/cb').ok, true);
t('★포트 없으면 거부', allow.check('goditor', 'http://127.0.0.1/cb').ok, false);
t('★localhost 거부(DNS 로 돌릴 수 있다)', allow.check('goditor', 'http://localhost:51234/cb').ok, false);
t('★외부 호스트 거부', allow.check('goditor', 'http://evil.com:80/cb').ok, false);
t('★127.0.0.1.evil.com 거부', allow.check('goditor', 'http://127.0.0.1.evil.com:80/cb').ok, false);
t('★https 루프백 거부(http 만)', allow.check('goditor', 'https://127.0.0.1:443/cb').ok, false);

console.log('\n■ 리디렉션 — godiv (등록된 확장 ID 만)');
const EXT = process.env.GODIV_EXTENSION_ID;
t('등록된 확장 주소 통과', allow.check('godiv', `https://${EXT}.chromiumapp.org/cb`).ok, true);
t('★다른 확장 ID 거부', allow.check('godiv', 'https://ponmlkjihgfedcbaponmlkjihgfedcba.chromiumapp.org/cb').ok, false);
t('★유사 도메인 거부', allow.check('godiv', `https://${EXT}.chromiumapp.org.evil.com/cb`).ok, false);
t('★http 거부', allow.check('godiv', `http://${EXT}.chromiumapp.org/cb`).ok, false);
t('★확장 ID 미설정이면 경로 자체가 닫힌다', (() => {
  const saved = process.env.GODIV_EXTENSION_ID;
  delete process.env.GODIV_EXTENSION_ID;
  const r = allow.check('godiv', `https://${saved}.chromiumapp.org/cb`).ok;
  process.env.GODIV_EXTENSION_ID = saved;
  return r;
})(), false);

console.log('\n■ 모르는 app');
t('★알 수 없는 app 은 거부(기본이 거부)', allow.check('nosuchapp', '/').ok, false);
t('★app 을 비워도 거부', allow.check('', '/').ok, false);

console.log(`\n${'─'.repeat(52)}`);
console.log(`통과 ${pass} · 실패 ${fail}`);
if (fail) {
  console.log('\n실패 목록:');
  bad.forEach((b) => console.log('  ✗ ' + b));
  process.exit(1);
}
console.log('★막아야 할 입력 22건이 실제로 막혔다.');
