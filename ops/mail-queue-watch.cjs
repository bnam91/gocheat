#!/usr/bin/env node
/**
 * 큐 밀림 감시 — «보내야 할 메일이 갇혀 있는데 아무도 모르는» 상태를 잡는다.
 *
 * ★★왜 EC2 에서 도나
 *   발송기(드레인)는 «맥»에서 돈다. 맥이 꺼지면 메일이 안 나간다.
 *   그런데 감시자까지 맥에 두면 «감시자도 같이 죽어» 아무 소용이 없다.
 *   ⇒ 감시는 «항상 켜져 있는 쪽»에서 해야 한다. 그래서 여기(EC2)다.
 *
 * ★임계값 5분인 이유 — 드레인이 60초 주기다. 5분을 넘겼으면 «순간 지연»이 아니라 «막힘»이다.
 *   더 짧게 잡으면 정상적인 지연에도 울려서, 곧 아무도 안 보게 된다.
 *
 * ★★같은 일로 «두 번 울리지 않는다»
 *   맥이 밤새 꺼져 있으면 5분마다 알림이 오면 안 된다.
 *   상태를 DB(ops_state)에 남겨 «막힘 시작»과 «해소»만 알린다.
 *   ⛔이 파일에 임계값·상태를 «메모리»로 들고 있지 마라 — 타이머가 매번 새 프로세스로 뜬다.
 *
 * ⛔로그에 수신자·본문·링크를 남기지 않는다. 개수와 나이만 찍는다.
 *
 * ⚠️★확장자가 «.cjs» 인 이유 — 처음에 .mjs 로 뒀다가 실행이 통째로 실패했다.
 *   .mjs 는 ESM 이라 require 가 «없다»(ReferenceError). 그런데 `node --check` 는 통과했다 —
 *   그건 «구문»만 보고, require 미정의는 «런타임» 오류라 안 잡히기 때문이다.
 *   ★「문법 OK」는 「돌아간다」가 아니다. 설치한 뒤 «실제로 한 번 실행»해서 확인해라.
 */
const { MongoClient } = require('/opt/goditor-api/node_modules/mongodb');

const STUCK_MS = 5 * 60 * 1000;              // 이보다 오래 pending 이면 «막힘»
const STATE_ID = 'mail_queue_watch';

function tg(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat  = process.env.TELEGRAM_CHAT_ID;
  // ★토큰이 없으면 «조용히 성공한 척하지 않는다» — 감시가 죽은 걸 알아야 한다.
  if (!token || !chat) { console.error('[watch] TELEGRAM_* 환경변수 없음 — 알림을 못 보낸다'); return Promise.resolve(false); }
  const body = JSON.stringify({ chat_id: chat, text });
  return new Promise((res) => {
    const req = require('https').request(
      { hostname: 'api.telegram.org', path: `/bot${token}/sendMessage`, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 15000 },
      (r) => { r.resume(); res(r.statusCode === 200); });
    req.on('error', (e) => { console.error('[watch] 텔레그램 전송 실패:', e.message); res(false); });
    req.on('timeout', () => { req.destroy(); res(false); });
    req.end(body);
  });
}

(async () => {
  const uri = process.env.MONGO_URI;
  if (!uri) { console.error('[watch] MONGO_URI 없음'); process.exit(1); }
  const cli = new MongoClient(uri, { serverSelectionTimeoutMS: 15000 });
  try {
    await cli.connect();
    const db = cli.db(process.env.MONGO_DB || 'goditor_license');
    const now = new Date();
    const cutoff = new Date(now.getTime() - STUCK_MS);

    // ★«보낼 수 있는데 안 나간 것»만 센다 — 만료(notAfter 지남)는 드레인이 일부러 건너뛴다.
    //   그걸 같이 세면 «영원히 해소되지 않는» 경보가 된다.
    const stuck = await db.collection('mail_queue').countDocuments({
      status: 'pending',
      createdAt: { $lte: cutoff },
      $or: [{ notAfter: null }, { notAfter: { $exists: false } }, { notAfter: { $gt: now } }],
    });

    const st = db.collection('ops_state');
    const prev = (await st.findOne({ _id: STATE_ID })) || { stuck: false };

    if (stuck > 0 && !prev.stuck) {
      const oldest = await db.collection('mail_queue')
        .find({ status: 'pending', createdAt: { $lte: cutoff } })
        .sort({ createdAt: 1 }).limit(1).toArray();
      const mins = oldest.length ? Math.round((now - new Date(oldest[0].createdAt)) / 60000) : 0;
      await tg(`[소문의섬] ⛔메일 발송이 막혔습니다\n\n`
        + `보내지 못한 메일 ${stuck}건 (가장 오래된 것 ${mins}분 경과)\n\n`
        + `발송기는 «맥»에서 돕니다 — 맥이 꺼져 있는지 확인해 주세요.\n`
        + `★비밀번호 재설정 링크는 30분 만료라, 늦게 나가면 죽은 링크가 도착합니다.`);
      await st.updateOne({ _id: STATE_ID }, { $set: { stuck: true, since: now, count: stuck } }, { upsert: true });
      console.log('[watch] 막힘 알림 보냄:', stuck, '건');
    } else if (stuck === 0 && prev.stuck) {
      const mins = prev.since ? Math.round((now - new Date(prev.since)) / 60000) : 0;
      await tg(`[소문의섬] ✅메일 발송이 정상으로 돌아왔습니다 (${mins}분 만에 해소)`);
      await st.updateOne({ _id: STATE_ID }, { $set: { stuck: false, resolvedAt: now } }, { upsert: true });
      console.log('[watch] 해소 알림 보냄');
    } else {
      console.log('[watch] 막힌 메일', stuck, '건 · 상태변화 없음');
    }
  } catch (e) {
    // ⛔삼키지 않는다 — 감시자가 조용히 죽으면 «감시가 있다고 믿는» 상태가 제일 위험하다.
    console.error('[watch] 실패:', e.message);
    process.exitCode = 1;
  } finally { await cli.close().catch(() => {}); }
})();
