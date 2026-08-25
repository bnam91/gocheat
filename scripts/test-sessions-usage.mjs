/* 세션 분리 + 사용기록 «실 DB 왕복» 테스트.
 *
 * ★왜 이 파일이 있나 (2026-08-25)
 *   1차 구현은 스텁 DB로만 검사했다. 그래서 「집계 파이프라인 업데이트가 실제로 도는가」,
 *   「$min·$inc·$set 조합이 몽고에서 받아들여지는가」를 «아무도 확인하지 못한 채» 커밋됐다.
 *   ⇒ 인메모리 몽고를 띄워 진짜로 왕복시킨다. 스텁은 모양만 보고, 이건 «동작»을 본다.
 *
 * 실행:
 *   npm i -D mongodb-memory-server      # 최초 1회(약 100MB 바이너리 내려받음)
 *   node scripts/test-sessions-usage.mjs
 *   ※ 패키지가 없으면 «건너뛴다»(exit 0). 배포 파이프라인을 막지 않기 위해서다 —
 *     ⛔대신 「건너뜀」을 «통과»로 읽지 마라. 출력에 SKIP 이 보이면 검증은 안 된 것이다.
 */
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let MongoMemoryServer;
try { ({ MongoMemoryServer } = require('mongodb-memory-server')); }
catch { console.log('SKIP — mongodb-memory-server 없음. `npm i -D mongodb-memory-server` 후 다시 실행하라.'); process.exit(0); }

const { MongoClient } = require('mongodb');
const S = require(path.join(ROOT, 'api/_lib/sessions.js'));

let pass = 0;
const ok = (cond, what) => { if (!cond) throw new Error(`FAIL — ${what}`); pass++; console.log(`  ✓ ${what}`); };

const mem = await MongoMemoryServer.create();
const client = await MongoClient.connect(mem.getUri());
const db = client.db('t');
const users = db.collection('users');

async function reset(doc) { await users.deleteMany({}); await users.insertOne(doc); }
const get = () => users.findOne({ email: 'a@b.c' });
const apps = (u) => (u.sessions || []).map((s) => s.app).sort();

try {
  console.log('\n[1] ★회귀 — 구식 유저(sessions 없음)가 홈페이지에 로그인해도 확장 토큰이 살아있나');
  await reset({ email: 'a@b.c', verified: true, sessionToken: 'T_OLD', sessionIssuedAt: new Date('2026-08-01') });
  await S.issueSession(db, 'a@b.c', 'web');
  let u = await get();
  ok(!!(await S.findUserBySession(db, 'T_OLD')), '옛 토큰 T_OLD 가 «여전히» 통과한다(백필됨)');
  ok(apps(u).join(',') === 'legacy,web', `칸이 legacy+web 두 개다 (실제: ${apps(u).join(',')})`);
  ok(u.sessions.find((s) => s.app === 'legacy').backfilled === true, '옮겨 담긴 칸에 backfilled 표식이 있다');
  ok(u.sessions.find((s) => s.app === 'legacy').issuedAt.getTime() === new Date('2026-08-01').getTime(), '원래 발급시각을 보존한다');

  console.log('\n[2] 제품별 칸 — 확장 로그인 뒤 홈페이지 로그인해도 확장이 안 튕긴다');
  await reset({ email: 'a@b.c', verified: true });
  const godiv = await S.issueSession(db, 'a@b.c', 'godiv');
  await S.issueSession(db, 'a@b.c', 'web');
  ok(!!(await S.findUserBySession(db, godiv.sessionToken)), 'godiv 토큰이 web 로그인 뒤에도 유효');
  ok(apps(await get()).join(',') === 'godiv,web', '칸 2개');

  console.log('\n[3] 같은 앱 재로그인 — 앱당 1개가 지켜지고 옛 토큰은 죽는다');
  const godiv2 = await S.issueSession(db, 'a@b.c', 'godiv');
  ok(!(await S.findUserBySession(db, godiv.sessionToken)), '같은 앱의 옛 토큰은 무효');
  ok(!!(await S.findUserBySession(db, godiv2.sessionToken)), '새 토큰은 유효');
  ok((await get()).sessions.filter((s) => s.app === 'godiv').length === 1, 'godiv 칸은 여전히 1개');

  console.log('\n[4] ★동시 로그인 — 같은 앱 2건이 겹쳐도 앱당 1개인가(원자성)');
  await reset({ email: 'a@b.c', verified: true });
  await Promise.all([S.issueSession(db, 'a@b.c', 'godiv'), S.issueSession(db, 'a@b.c', 'godiv')]);
  ok((await get()).sessions.filter((s) => s.app === 'godiv').length === 1, '동시 2건이어도 godiv 칸 1개');

  console.log('\n[5] 전체 상한 — 앱 종류가 늘어도 문서가 무한히 자라지 않는다');
  await reset({ email: 'a@b.c', verified: true });
  for (let i = 0; i < S.MAX_TOTAL + 3; i++) await S.issueSession(db, 'a@b.c', `app${i}`);
  u = await get();
  ok(u.sessions.length === S.MAX_TOTAL, `${S.MAX_TOTAL}개로 잘린다 (실제 ${u.sessions.length})`);
  ok(u.sessions[u.sessions.length - 1].app === `app${S.MAX_TOTAL + 2}`, '가장 최근 것이 남는다');

  console.log('\n[6] 백필 멱등 — 여러 번 로그인해도 legacy 칸이 늘어나지 않는다');
  await reset({ email: 'a@b.c', verified: true, sessionToken: 'T_OLD' });
  await S.issueSession(db, 'a@b.c', 'web');
  await S.issueSession(db, 'a@b.c', 'web');
  ok((await get()).sessions.filter((s) => s.app === 'legacy').length === 1, 'legacy 칸 1개');

  console.log('\n[7] 인덱스 — $or 조회가 실제로 인덱스를 타는가');
  await users.createIndex({ sessionToken: 1 }, { sparse: true });
  await users.createIndex({ 'sessions.token': 1 }, { sparse: true });
  const plan = await users.find({ $or: [{ sessionToken: 'x' }, { 'sessions.token': 'x' }] }).explain('queryPlanner');
  const stage = JSON.stringify(plan.queryPlanner.winningPlan);
  ok(!stage.includes('COLLSCAN'), `전수주사(COLLSCAN)가 아니다`);

  console.log('\n[8] ★사용기록 — $set·$inc·$min 조합이 실제 몽고에서 도는가 (성공 1건)');
  await reset({ email: 'a@b.c', verified: true, plan: 'event_free' });
  const now = new Date();
  await users.updateOne({ email: 'a@b.c' }, {
    $set: { 'usage.godiv.lastAttemptAt': now, 'usage.godiv.lastPlan': 'event_free', 'usage.godiv.lastAt': now, 'usage.godiv.lastSite': 'naver' },
    $inc: { 'usage.godiv.attempts': 1, 'usage.godiv.count': 1, 'usage.godiv.images': 12, 'usage.godiv.sites.naver': 1 },
    $min: { 'usage.godiv.firstAt': now },
  });
  let g = (await get()).usage.godiv;
  ok(g.count === 1 && g.images === 12 && g.sites.naver === 1, '카운터가 정확히 오른다');
  ok(g.firstAt.getTime() === now.getTime(), '$min 이 없는 필드에 최초값을 넣는다');

  console.log('\n[9] $min 이 «최초»를 지키는가 — 나중 시각으로 덮이면 안 된다');
  const later = new Date(now.getTime() + 60000);
  await users.updateOne({ email: 'a@b.c' }, { $min: { 'usage.godiv.firstAt': later } });
  ok((await get()).usage.godiv.firstAt.getTime() === now.getTime(), 'firstAt 이 그대로다');

  console.log('\n[10] 0장 실패 — count 는 안 오르고 failed 만 오른다');
  await users.updateOne({ email: 'a@b.c' }, {
    $set: { 'usage.godiv.lastFailAt': now, 'usage.godiv.lastFailSite': 'wadiz' },
    $inc: { 'usage.godiv.attempts': 1, 'usage.godiv.failed': 1 },
    $min: { 'usage.godiv.firstAt': now },
  });
  g = (await get()).usage.godiv;
  ok(g.count === 1 && g.failed === 1 && g.attempts === 2, 'count 1 · failed 1 · attempts 2');

  console.log('\n[11] 원장 + TTL 인덱스가 실제로 만들어지는가');
  const ev = db.collection('godiv_events');
  await ev.createIndex({ email: 1, at: -1 });
  await ev.createIndex({ site: 1, at: -1 });
  await ev.createIndex({ at: 1 }, { expireAfterSeconds: 180 * 24 * 60 * 60 });
  await ev.insertOne({ email: 'a@b.c', at: now, site: 'naver', expected: 12, ok: 12, result: 'ok', plan: 'event_free' });
  const idx = await ev.indexes();
  ok(idx.some((i) => i.expireAfterSeconds === 180 * 24 * 60 * 60), 'TTL 인덱스 180일이 걸린다');
  ok((await ev.countDocuments()) === 1, '이벤트 1건 적재');
  ok(!Object.keys(await ev.findOne({})).some((k) => ['url', 'title', 'href'].includes(k)), '원장에 URL·제목 필드가 없다');

  console.log('\n[12] 일회성 백필 스크립트가 실제로 도는가 (dry-run → apply → 멱등)');
  await users.deleteMany({});
  await users.insertMany([
    { email: 'old1@b.c', verified: true, sessionToken: 'X1', sessionIssuedAt: new Date('2026-07-01') },
    { email: 'old2@b.c', verified: true, sessionToken: 'X2' },
    { email: 'new1@b.c', verified: true, sessionToken: 'Y1', sessions: [{ app: 'godiv', token: 'Y1', issuedAt: new Date() }] },
    { email: 'none@b.c', verified: true },
  ]);
  const run = (args) => spawnSync(process.execPath, [path.join(ROOT, 'scripts/backfill-sessions.mjs'), ...args],
    { env: { ...process.env, MONGO_URI: mem.getUri(), MONGO_DB: 't' }, encoding: 'utf8' });
  let out = run([]).stdout;
  ok(/옮길 대상 2명/.test(out) && /dry-run/.test(out), `dry-run 이 대상 2명만 «세고» 쓰지 않는다 (${out.trim()})`);
  ok((await users.findOne({ email: 'old1@b.c' })).sessions === undefined, 'dry-run 뒤에도 문서가 그대로다');
  out = run(['--apply']).stdout;
  ok(/실제 반영 2명/.test(out), `--apply 가 2명을 옮긴다 (${out.trim()})`);
  ok(!!(await S.findUserBySession(db, 'X1')) && !!(await S.findUserBySession(db, 'X2')), '옮긴 뒤 옛 토큰들이 통과한다');
  ok((await users.findOne({ email: 'new1@b.c' })).sessions.length === 1, '이미 신식인 사람은 안 건드린다');
  out = run(['--apply']).stdout;
  ok(/옮길 대상 0명/.test(out), '두 번 돌려도 대상 0명(멱등)');

  console.log('\n[13] 엣지 — «$»로 시작하는 토큰이 필드 경로로 오인되지 않는가($literal 방어)');
  await reset({ email: 'a@b.c', verified: true });
  await users.updateOne({ email: 'a@b.c' }, S.buildIssuePipeline('godiv', '$sessionToken', new Date()));
  ok((await get()).sessions[0].token === '$sessionToken', '토큰이 «문자 그대로» 저장된다(치환 안 됨)');
  ok(!!(await S.findUserBySession(db, '$sessionToken')), '그 토큰으로 조회도 된다');

  console.log('\n[14] 엣지 — legacy 칸이 이미 있는데 구식 토큰이 «다른 값»일 때 (⛔의도된 동작)');
  await reset({ email: 'a@b.c', verified: true, sessionToken: 'T_OLD',
    sessions: [{ app: 'legacy', token: 'T_LEGACY', issuedAt: new Date('2026-08-01') }] });
  await S.issueSession(db, 'a@b.c', 'web');
  ok(!!(await S.findUserBySession(db, 'T_OLD')) && !!(await S.findUserBySession(db, 'T_LEGACY')),
    '★둘 다 살린다 — 어느 쪽이 쓰이는 열쇠인지 모르므로 «튕기지 않는 쪽»으로 기운다');
  ok((await get()).sessions.filter((s) => s.app === 'legacy').length === 2,
    'legacy 칸이 일시적으로 2개다(앱당 1개는 «발급»의 불변식이지 백필 순간의 것이 아니다)');
  await S.issueSession(db, 'a@b.c', 'legacy');
  ok((await get()).sessions.filter((s) => s.app === 'legacy').length === 1, '다음 legacy 로그인에서 1개로 정리된다');
  ok(!(await S.findUserBySession(db, 'T_OLD')) && !(await S.findUserBySession(db, 'T_LEGACY')), '옛 legacy 토큰들은 그때 무효화된다');

  console.log(`\nPASS — 실 DB 왕복 ${pass}항목 통과`);
} catch (e) {
  console.error(`\n${e.message}`);
  process.exitCode = 1;
} finally {
  await client.close();
  await mem.stop();
}
