/**
 * API 헬스체크 감시 — 「서비스가 죽어도 아무도 모르는」 상태를 막는다.
 *
 * ★왜 필요한가
 *   goditor-api 는 Restart=always 라 죽으면 «되살아난다». 그런데 «반복해서» 죽으면
 *   아무도 모른다. 메일 큐는 감시하는데 정작 API 자체는 감시가 없었다.
 *
 * ★판정은 «상태 변화»로 한다 — mail-queue-watch 와 같은 틀.
 *   ops_state 에 상태를 남겨 «장애 시작»과 «복구»만 알린다. 5분마다 울리지 않는다.
 *
 * ★★«2회 연속 실패»여야 알린다.
 *   한 번의 순간적 실패(배포 중 재시작·네트워크 순간 끊김)로 울리면 곧 아무도 안 본다.
 *   ⇒ 연속 실패 수를 ops_state 에 쌓고 2 이상일 때만 알린다.
 *
 * ⛔405 를 «정상»으로 본다 — 이 엔드포인트는 POST 전용이라 GET 은 405 가 «맞다».
 *   200 을 기대하면 영원히 장애로 보인다(실제로 그렇게 짤 뻔했다).
 */
const https = require('https');
const { MongoClient } = require('/opt/goditor-api/node_modules/mongodb');

const URL = process.env.HEALTH_URL || 'https://blacksheepwall.kr/api/license/session';
const OK_CODES = [405, 401, 400];   // ★POST 전용 경로에 GET 을 던진 «정상» 응답들
const STATE_ID = 'api_health_watch';
const FAIL_THRESHOLD = 2;
const TIMEOUT_MS = 12000;

function probe() {
  return new Promise((res) => {
    const t0 = Date.now();
    const req = https.get(URL, { timeout: TIMEOUT_MS }, (r) => {
      r.resume();
      res({ ok: OK_CODES.includes(r.statusCode), code: r.statusCode, ms: Date.now() - t0 });
    });
    req.on('error', (e) => res({ ok: false, code: 0, ms: Date.now() - t0, err: e.message }));
    req.on('timeout', () => { req.destroy(); res({ ok: false, code: 0, ms: TIMEOUT_MS, err: 'timeout' }); });
  });
}

function tg(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  // ★토큰이 없으면 «성공한 척하지 않는다» — 감시가 죽은 걸 알아야 한다.
  if (!token || !chat) { console.error('[health] TELEGRAM_* 없음 — 알림 못 보냄'); return Promise.resolve(false); }
  const body = JSON.stringify({ chat_id: chat, text });
  return new Promise((res) => {
    const req = https.request({ hostname: 'api.telegram.org', path: `/bot${token}/sendMessage`, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 15000 },
      (r) => { r.resume(); res(r.statusCode === 200); });
    req.on('error', () => res(false));
    req.on('timeout', () => { req.destroy(); res(false); });
    req.end(body);
  });
}

(async () => {
  const uri = process.env.MONGO_URI;
  if (!uri) { console.error('[health] MONGO_URI 없음'); process.exit(1); }
  const r = await probe();
  const cli = new MongoClient(uri, { serverSelectionTimeoutMS: 15000 });
  try {
    await cli.connect();
    const st = cli.db(process.env.MONGO_DB || 'goditor_license').collection('ops_state');
    const prev = (await st.findOne({ _id: STATE_ID })) || { down: false, fails: 0 };
    const fails = r.ok ? 0 : (prev.fails || 0) + 1;
    const now = new Date();

    if (!r.ok && fails >= FAIL_THRESHOLD && !prev.down) {
      await tg(`[소문의섬] ⛔API 가 응답하지 않습니다\n\n${URL}\n`
        + `상태 ${r.code || '연결실패'}${r.err ? ' (' + r.err + ')' : ''} · ${fails}회 연속\n\n`
        + `서비스는 자동 재시작되지만 «반복해서» 죽고 있을 수 있습니다.\n`
        + `journalctl -u goditor-api -n 50 으로 확인해 주세요.`);
      await st.updateOne({ _id: STATE_ID }, { $set: { down: true, fails, since: now, code: r.code } }, { upsert: true });
      console.log(`[health] 장애 알림 보냄 (${fails}회 연속, code=${r.code})`);
    } else if (r.ok && prev.down) {
      const mins = prev.since ? Math.round((now - new Date(prev.since)) / 60000) : 0;
      await tg(`[소문의섬] ✅API 가 정상으로 돌아왔습니다 (${mins}분 만에 복구 · ${r.ms}ms)`);
      await st.updateOne({ _id: STATE_ID }, { $set: { down: false, fails: 0, recoveredAt: now } }, { upsert: true });
      console.log('[health] 복구 알림 보냄');
    } else {
      await st.updateOne({ _id: STATE_ID }, { $set: { down: prev.down && !r.ok, fails, lastAt: now, lastCode: r.code, lastMs: r.ms } }, { upsert: true });
      console.log(`[health] ${r.ok ? 'ok' : 'fail'} code=${r.code} ${r.ms}ms · 연속실패 ${fails} · 상태변화 없음`);
    }
  } catch (e) {
    console.error('[health] 실패:', e.message);   // ⛔삼키지 않는다
    process.exitCode = 1;
  } finally { await cli.close().catch(() => {}); }
})();
