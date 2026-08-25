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

/* ★use.js «핸들러 자체»를 실제 몽고에 물려 부른다 (2026-08-25 2차 검수 지적 반영).
 *   전엔 테스트가 $set/$inc/$min 을 «손으로 다시 써서» 검사했다 — 그건 동어반복이라
 *   use.js 의 키 오타·clampCount·result 판정·401 대조·스로틀이 하나도 안 걸렸다. */
let db;   // 아래에서 연결 후 대입 — getDb 는 호출 시점에 읽으므로 순서 문제 없다
const mongoPath = require.resolve(path.join(ROOT, 'api/_lib/mongo.js'));
require.cache[mongoPath] = { id: mongoPath, filename: mongoPath, loaded: true, exports: { getDb: async () => db, DB_NAME: 't' } };
const useHandler = require(path.join(ROOT, 'api/godiv/use.js'));
const callUse = async (body) => {
  const out = {};
  const res = { statusCode: 0, setHeader() {}, end(b) { out.status = this.statusCode; out.body = JSON.parse(b); } };
  await useHandler({ method: 'POST', body, on() {} }, res);
  return out;
};

let pass = 0;
const ok = (cond, what) => { if (!cond) throw new Error(`FAIL — ${what}`); pass++; console.log(`  ✓ ${what}`); };

const mem = await MongoMemoryServer.create();
const client = await MongoClient.connect(mem.getUri());
db = client.db('t');
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
  ok(apps(u).join(',') === '_backfill,web', `칸이 _backfill+web 두 개다 (실제: ${apps(u).join(',')})`);
  ok(u.sessions.find((s) => s.app === '_backfill').backfilled === true, '옮겨 담긴 칸에 backfilled 표식이 있다');
  ok(u.sessions.find((s) => s.app === '_backfill').issuedAt.getTime() === new Date('2026-08-01').getTime(), '원래 발급시각을 보존한다');

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
  ok((await get()).sessions.filter((s) => s.app === '_backfill').length === 1, '백필 칸 1개');

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

  console.log('\n[14] 엣지 — legacy 칸이 이미 있는데 구식 토큰이 «다른 값»일 때 (예약 칸 도입 후)');
  await reset({ email: 'a@b.c', verified: true, sessionToken: 'T_ORPHAN',
    sessions: [{ app: 'legacy', token: 'T_LEGACY', issuedAt: new Date('2026-08-01') }] });
  await S.issueSession(db, 'a@b.c', 'web');
  ok(!!(await S.findUserBySession(db, 'T_ORPHAN')) && !!(await S.findUserBySession(db, 'T_LEGACY')),
    '둘 다 산다 — 어느 쪽이 쓰이는 열쇠인지 모르므로 «튕기지 않는 쪽»으로 기운다');
  ok((await get()).sessions.filter((s) => s.app === 'legacy').length === 1,
    '★legacy 칸은 1개다 — 백필이 예약 칸(_backfill)으로 가므로 앱당 1개가 안 깨진다');

  console.log('\n[15] ★H1 회귀 — app 을 «안 보내는» 클라이언트(고디터 데스크톱·구버전 확장)로 로그인해도 옛 토큰이 사나');
  await reset({ email: 'a@b.c', verified: true, sessionToken: 'T_OLD', sessionIssuedAt: new Date('2026-08-01') });
  await S.issueSession(db, 'a@b.c', undefined);          // app 미전송 → 'legacy'
  ok(!!(await S.findUserBySession(db, 'T_OLD')), 'T_OLD 가 살아있다 (예약 칸으로 분리한 덕)');
  ok(apps(await get()).join(',') === '_backfill,legacy', `칸이 _backfill+legacy (실제: ${apps(await get()).join(',')})`);

  console.log('\n[16] 예약 칸 사칭 차단 — 클라이언트가 app:"_backfill" 을 보내도 그 칸을 못 건드린다');
  const before = (await get()).sessions.find((s) => s.app === '_backfill').token;
  await S.issueSession(db, 'a@b.c', '_backfill');
  const after = (await get()).sessions.find((s) => s.app === '_backfill');
  ok(after && after.token === before, '예약 칸이 그대로다(요청은 legacy 칸으로 눌림)');
  ok(!!(await S.findUserBySession(db, 'T_OLD')), '옛 토큰도 여전히 산다');

  console.log('\n[17] 이물질 — null·app 없는 엔트리가 섞여 있으면 걷어내는가');
  await reset({ email: 'a@b.c', verified: true, sessions: [null, { token: 'NOAPP' }, { app: 'web', token: 'W1', issuedAt: new Date() }] });
  await S.issueSession(db, 'a@b.c', 'godiv');
  ok((await get()).sessions.every((s) => s && typeof s.app === 'string'), '이물질이 사라졌다');
  ok(!!(await S.findUserBySession(db, 'W1')), '멀쩡한 칸은 그대로 산다');

  console.log('\n[18] 없는 계정에 발급하면 «성공처럼» 돌려주지 않는가');
  let threw = false;
  try { await S.issueSession(db, 'ghost@b.c', 'godiv'); } catch (e) { threw = /no_user/.test(e.message); }
  ok(threw, '문서가 없으면 예외를 던진다');

  console.log('\n[19] ★use.js 핸들러 «직접» 호출 — 판정·방어·스로틀이 실제로 도는가');
  await reset({ email: 'a@b.c', verified: true, plan: 'event_free' });
  const tok = (await S.issueSession(db, 'a@b.c', 'godiv')).sessionToken;
  const agedOut = () => users.updateOne({ email: 'a@b.c' }, { $set: { 'usage.godiv.lastAttemptAt': new Date(Date.now() - 60000) } });

  let r = await callUse({ sessionToken: tok, site: 'naver', expected: 12, ok: 12 });
  ok(r.body.result === 'ok' && r.body.recorded, '완전 성공 → result=ok');
  await agedOut();
  r = await callUse({ sessionToken: tok, site: 'coupang', expected: 10, ok: 4 });
  ok(r.body.result === 'partial', '부분 성공 → result=partial');
  await agedOut();
  r = await callUse({ sessionToken: tok, site: 'evil.com', expected: 3, ok: 0, url: 'https://smartstore.naver.com/x/products/1' });
  ok(r.body.result === 'none', '0장 → result=none');
  const lastEv = await db.collection('godiv_events').find({}).sort({ at: -1 }).limit(1).next();
  ok(lastEv.site === 'other', '화이트리스트 밖 site 는 other 로 눌린다');
  ok(!JSON.stringify(lastEv).includes('smartstore'), '★URL 을 섞어 보내도 원장에 안 들어간다');
  const g2 = (await get()).usage.godiv;
  ok(g2.count === 2 && g2.failed === 1 && g2.attempts === 3, `카운터 실집계 (count ${g2.count}·failed ${g2.failed}·attempts ${g2.attempts})`);

  console.log('\n[20] ★스로틀 — 연달아 두드리면 두 번째부터 무시되는가(지표 자가조작 방지)');
  await agedOut();
  const c0 = (await get()).usage.godiv.count;
  const first = await callUse({ sessionToken: tok, site: 'naver', expected: 1, ok: 1 });
  const second = await callUse({ sessionToken: tok, site: 'naver', expected: 1, ok: 1 });
  ok(first.body.recorded === true, '첫 호출은 기록된다');
  ok(second.body.throttled === true && second.body.recorded === false, '3초 안의 두 번째 호출은 무시된다');
  ok((await get()).usage.godiv.count === c0 + 1, `count 가 1만 올랐다 (${c0}→${(await get()).usage.godiv.count})`);
  const evs = await db.collection('godiv_events').countDocuments({ site: 'naver', ok: 1 });
  ok(evs === 1, '스로틀된 호출은 원장에도 안 들어간다');

  console.log('\n[21] 이메일 짝이 안 맞으면 401 — 핸들러가 실제로 거절하는가');
  r = await callUse({ sessionToken: tok, email: 'other@b.c', site: 'naver', ok: 1 });
  ok(r.status === 401 && r.body.reason === 'invalid_session', '401 invalid_session');

  console.log('\n[22] 세션 나이 — 토큰이 든 «칸»의 발급시각을 준다(전역값 아님)');
  await reset({ email: 'a@b.c', verified: true });
  const gd = await S.issueSession(db, 'a@b.c', 'godiv');
  await new Promise((r2) => setTimeout(r2, 5));
  await S.issueSession(db, 'a@b.c', 'web');              // 전역 sessionIssuedAt 이 web 것으로 바뀐다
  const u2 = await get();
  ok(S.issuedAtOf(u2, gd.sessionToken).getTime() === gd.issuedAt.getTime(), 'godiv 칸의 발급시각이 그대로다');
  ok(u2.sessionIssuedAt.getTime() !== gd.issuedAt.getTime(), '전역값은 web 로그인으로 바뀌었다(그래서 칸별 값이 필요하다)');

  console.log(`\nPASS — 실 DB 왕복 ${pass}항목 통과`);
} catch (e) {
  console.error(`\n${e.message}`);
  process.exitCode = 1;
} finally {
  await client.close();
  await mem.stop();
}
