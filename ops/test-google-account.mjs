/* 계정 연결(설계 §3) «적대적» 검사 — 진짜 MongoDB 에 대고 돈다.
 *
 * ★가짜 DB 로 하지 않는 이유
 *   여기서 검증하려는 것이 $setOnInsert · upsert · 조건부 매치 같은 «Mongo 의 시맨틱»이다.
 *   그걸 흉내낸 mock 으로 재면 «mock 이 맞는가»를 재는 것이지 코드를 재는 게 아니다.
 *   ⇒ ★★«라이브 DB»(goditor_license)에 붙는다. 원해서가 아니라 «거기밖에 없어서»다.
 *
 * ★경위(2026-09-06 실측) — 안전한 순서로 시도해서 «전부 막혔다»
 *   ①새 DB 를 만들어 통째로 drop  → Atlas 가 createIndex 를 거부(권한 없음)
 *   ②개발 DB(goditor_license_dev) → ★읽기·쓰기·삭제가 «전부» 막힘(이 계정에 권한이 없다)
 *   ③라이브 DB                     → 읽기·쓰기·삭제 가능. 인덱스도 정상(email_1 존재)
 *   ⇒ 우회하지 않고 «안전장치를 코드에» 박는 쪽을 골랐다. 아래 GUARD 참조.
 *
 * ⛔이 파일에서 지켜야 하는 것 (어기면 실계정을 건드린다)
 *   ①만드는 주소는 «전부» `oauthtest<시각>-*@example.invalid` — example.invalid 는
 *     RFC 2606 예약 도메인이라 실사용자와 «절대» 겹치지 않는다.
 *   ②이메일 조건이 «없는» 쿼리를 쓰지 마라(countDocuments({}) 같은 것).
 *   ③drop·deleteMany(전체) 금지. 정리는 이 실행의 접두사로만.
 *   ④GUARD 가 접두사 밖 주소를 만들려는 시도를 «던져서» 막는다.
 *
 * 실행: MONGO_URI=... node ops/test-google-account.mjs
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

/* ⚠️★라이브 DB 다. 위 머리글의 ⛔네 가지를 반드시 지킬 것. */
const TEST_DB = 'goditor_license';
const RUN = 'oauthtest' + Date.now() + '-';
process.env.MONGO_DB = TEST_DB;
process.env.EVENT_UNTIL = '2026-12-31T23:59:59Z';

const { getDb } = require('../api/_lib/mongo.js');
const { upsertFromGoogle } = require('../api/_lib/google-account.js');

let pass = 0, fail = 0; const bad = [];
function t(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : (fail++, bad.push(`${name}\n     기대=${JSON.stringify(want)}  실제=${JSON.stringify(got)}`));
  console.log(`  ${ok ? '✓' : '✗'} ${name}`);
}

/* ★GUARD — 이 실행이 만드는 주소는 «반드시» 이 모양이어야 한다.
   테스트를 고치다 실수로 진짜 주소를 넣는 것을 «코드가» 막는다. */
const M = (local) => {
  const addr = RUN + local + '@example.invalid';
  if (!addr.startsWith(RUN) || !addr.endsWith('@example.invalid')) {
    throw new Error('GUARD: 테스트 주소 규칙 위반 — ' + addr);
  }
  return addr;
};
const G = (over = {}) => ({ sub: '1078', email: M('tester'), email_verified: true, name: '테스터', ...over });

const db = await getDb();
const users = db.collection('users');
console.log(`\nDB = ${TEST_DB} · 이 실행 전용 주소 접두사 = ${RUN}\n`);

try {
  // ── 1. 신규 ────────────────────────────────────────────────
  console.log('■ 새 계정');
  let r = await upsertFromGoogle(G());
  t('구글로 새 가입이 된다', r.ok, true);
  t('신규로 표시된다(추가정보로 보낸다)', r.created, true);
  let u = await users.findOne({ email: M('tester') });
  t('★passwordHash 가 없다', u.passwordHash, undefined);
  t('★verified 가 true(인증메일 불필요)', u.verified, true);
  t('★verificationToken 을 안 만든다', u.verificationToken, undefined);
  t('googleSub 가 박힌다', u.googleSub, '1078');
  t('provider 가 google', u.provider, 'google');
  t('plan 은 이메일 가입과 같다', u.plan, 'event_free');
  t('★profile 이 비어 있다(휴대전화는 구글이 안 준다)', u.profile, undefined);
  t('★consents 가 비어 있다(동의는 우리가 받는다)', u.consents, undefined);

  // ── 2. 재방문 ──────────────────────────────────────────────
  console.log('\n■ 같은 사람이 다시 로그인');
  r = await upsertFromGoogle(G());
  t('통과한다', r.ok, true);
  t('★신규가 아니다', r.created, false);
  t('계정이 하나뿐이다', await users.countDocuments({ email: M('tester') }), 1);

  // ── 3. 막아야 하는 것 ──────────────────────────────────────
  console.log('\n■ 거절해야 하는 입력');
  t('★email_verified=false → 거절', (await upsertFromGoogle(G({ email: M('x'), email_verified: false }))).reason, 'google_email_unverified');
  t('★email_verified="false"(문자열) → 거절', (await upsertFromGoogle(G({ email: M('y'), email_verified: 'false' }))).reason, 'google_email_unverified');
  t('★email_verified 없음 → 거절', (await upsertFromGoogle({ sub: '9', email: M('z') })).reason, 'google_email_unverified');
  t('거절된 이메일은 계정이 «안 생겼다»', await users.countDocuments({ email: { $in: [M('x'), M('y'), M('z')] } }), 0);
  t('★같은 이메일에 다른 구글계정 → 충돌', (await upsertFromGoogle(G({ sub: '9999' }))).reason, 'account_conflict');
  t('★충돌 후에도 원래 sub 가 그대로다', (await users.findOne({ email: M('tester') })).googleSub, '1078');
  t('이메일 없음 → 거절', (await upsertFromGoogle({ sub: '1', email_verified: true })).reason, 'no_email');
  t('sub 없음 → 거절', (await upsertFromGoogle({ email: M('a'), email_verified: true })).reason, 'no_sub');
  t('빈 입력 → 거절', (await upsertFromGoogle(null)).reason, 'no_profile');

  // ── 4. 기존 이메일 계정에 연결 ─────────────────────────────
  console.log('\n■ 이메일로 먼저 가입한 사람이 구글로 들어옴');
  await users.insertOne({
    email: M('old'), passwordHash: '$2a$10$fakehashfakehashfakehashfake',
    createdAt: new Date(), plan: 'event_free', verified: true, verifiedAt: new Date(),
    profile: { name: '기존', phone: '01011112222', phoneVerified: false },
    consents: { docVersion: '1', terms: { agreed: true, at: new Date() } },
  });
  r = await upsertFromGoogle(G({ sub: '2222', email: M('old') }));
  t('연결된다', r.ok, true);
  t('신규가 아니다', r.created, false);
  u = await users.findOne({ email: M('old') });
  t('googleSub 가 붙었다', u.googleSub, '2222');
  t('★passwordHash 가 그대로다(둘 다로 로그인 가능)', u.passwordHash, '$2a$10$fakehashfakehashfakehashfake');
  t('★기존 profile 을 안 덮었다', u.profile.phone, '01011112222');
  t('★기존 consents 를 안 덮었다', u.consents.terms.agreed, true);
  t('계정이 늘지 않았다', await users.countDocuments({ email: M('old') }), 1);

  // ── 5. 미인증 계정 + 구글 ─────────────────────────────────
  console.log('\n■ 이메일 인증을 안 끝낸 계정이 구글로 들어옴');
  await users.insertOne({
    email: M('unv'), passwordHash: '$2a$10$another', createdAt: new Date(),
    plan: 'event_free', verified: false, verificationToken: 'tok123',
  });
  r = await upsertFromGoogle(G({ sub: '3333', email: M('unv') }));
  u = await users.findOne({ email: M('unv') });
  t('연결된다', r.ok, true);
  t('★구글이 확인해 줬으므로 verified 가 true 로 올라간다', u.verified, true);
  t('★비밀번호는 여전히 원래 주인 것이다', u.passwordHash, '$2a$10$another');

  // ── 6. 추가정보가 없는 기존 계정 ──────────────────────────
  console.log('\n■ 확장수집 열리기 «전»에 가입해 profile 이 없는 사람');
  await users.insertOne({ email: M('noprof'), passwordHash: '$2a$10$x', createdAt: new Date(), plan: 'event_free', verified: true });
  r = await upsertFromGoogle(G({ sub: '4444', email: M('noprof') }));
  t('★추가정보를 채우러 보낸다(연락처 없는 회원을 안 남긴다)', r.needsProfile, true);

  // ── 7. 동시 요청 ──────────────────────────────────────────
  console.log('\n■ 같은 사람이 «동시에» 두 번 눌렀을 때');
  const both = await Promise.all([
    upsertFromGoogle(G({ sub: '5555', email: M('race') })),
    upsertFromGoogle(G({ sub: '5555', email: M('race') })),
  ]);
  t('둘 다 성공한다', both.every((x) => x.ok), true);
  t('★계정은 «하나»만 생긴다', await users.countDocuments({ email: M('race') }), 1);

  console.log(`\n${'─'.repeat(52)}`);
  console.log(`통과 ${pass} · 실패 ${fail}`);
  if (bad.length) { console.log('\n실패:'); bad.forEach((b) => console.log('  ✗ ' + b)); }
} finally {
  /* ⛔dropDatabase 금지 — 이 실행이 만든 문서«만» 지운다.
     ★지우기 «전»에 대상이 정말 내 것뿐인지 눈으로 확인한다(라이브 DB 다). */
  const targets = await users.find(
    { email: { $regex: '^' + RUN } }, { projection: { email: 1 } },
  ).toArray();
  const stray = targets.filter((x) => !x.email.endsWith('@example.invalid'));
  if (stray.length) {
    console.log('⛔삭제 중단 — 접두사에 걸렸는데 example.invalid 가 아닌 것이 있다:', stray.map((s) => s.email));
    throw new Error('정리 대상이 예상과 다르다');
  }
  console.log(`정리 대상 ${targets.length}건 (전부 ${RUN}*@example.invalid 확인됨)`);
  const del = await users.deleteMany({ email: { $regex: '^' + RUN } });
  const left = await users.countDocuments({ email: { $regex: '^' + RUN } });
  console.log(`정리: ${del.deletedCount}건 삭제 · 남은 것 ${left}건`);
  if (left) console.log('⚠️ 잔재가 남았다 — 수동 확인 필요');
  const { closeDb } = require('../api/_lib/mongo.js');
  if (typeof closeDb === 'function') await closeDb();
  process.exit(fail ? 1 : 0);
}
