/* mailq.js — 메일 큐의 «DB 쪽» 절반. EC2 에서만 돈다(MONGO_URI 가 거기에만 있다).
 *
 * ★왜 둘로 갈랐나
 *   보내는 자격증명(Gmail OAuth)은 «맥»에 있고, DB 자격증명(MONGO_URI)은 «EC2»에 있다.
 *   둘 중 하나를 옮기면 «새 비밀»이 생긴다. 옮기지 않는다 —
 *   맥이 이미 가진 SSH 키로 이 파일을 «호출»하고, 보내는 일만 맥에서 한다.
 *   ⇒ 서버에는 메일함 권한이 안 올라가고, 맥에는 DB 접속정보가 안 내려온다.
 *
 * ⛔이 파일은 docroot(/opt/goditor-api) «밖»에 둔다. 안에 두면 HTTP 로 읽힌다.
 *
 * 사용: node mailq.js claim [n]   — pending → sending 으로 «원자적으로» 집어 JSON 출력
 *       node mailq.js done  <id>  — 발송 성공 확정
 *       node mailq.js fail  <id> "사유"  — 실패. 상한을 넘으면 failed 로 마감
 *       node mailq.js sweep       — 만료·너무 오래된 pending 을 expired 로 마감
 *       node mailq.js stat        — 상태별 개수(로그·모니터용, 개인정보 미출력)
 */
const { MongoClient } = require('/opt/goditor-api/node_modules/mongodb');
const { pendingMailFilter, staleMailFilter } = require('/opt/goditor-api/api/_lib/mail.js');

const MAX_RETRY = 3;                       // ③재시도 상한
const LEASE_MS = 5 * 60 * 1000;            // ②락: 이 시간이 지나면 죽은 sending 을 회수한다

async function main() {
  const [cmd, a1, a2] = process.argv.slice(2);
  const c = new MongoClient(process.env.MONGO_URI, { serverSelectionTimeoutMS: 8000 });
  await c.connect();
  const q = c.db(process.env.MONGO_DB).collection('mail_queue');
  const now = new Date();

  if (cmd === 'claim') {
    const n = Math.min(Number(a1) || 5, 20);
    // ★죽은 lease 회수 — 드레이너가 도중에 죽으면 sending 인 채로 영원히 남는다
    await q.updateMany(
      { status: 'sending', claimedAt: { $lt: new Date(now.getTime() - LEASE_MS) } },
      { $set: { status: 'pending' }, $unset: { claimedAt: '' } },
    );
    const out = [];
    for (let i = 0; i < n; i++) {
      // ★★한 번의 원자연산으로 «집는다». findOne → updateOne 으로 쪼개면
      //   드레이너가 둘 돌 때 같은 메일을 둘 다 집어 «두 번 발송»된다.
      const r = await q.findOneAndUpdate(
        // ①만료 skip 은 pendingMailFilter 가, ③재시도 상한은 아래 $or 가 한다.
        // ★필드가 «없는» 옛 문서도 집을 수 있어야 한다 — {$lt} 만 쓰면 필드 없는 문서가 안 잡혀
        //   「영원히 pending 인데 아무도 안 집는」 유령이 된다.
        { ...pendingMailFilter(now),
          $and: [{ $or: [{ retryCount: { $lt: MAX_RETRY } }, { retryCount: { $exists: false } }] }] },
        { $set: { status: 'sending', claimedAt: now } },
        { sort: { createdAt: 1 }, includeResultMetadata: false },
      );
      const d = (r && 'lastErrorObject' in r) ? r.value : r;
      if (!d) break;
      out.push({ id: String(d._id), to: d.to, subject: d.subject, body: d.body });
    }
    process.stdout.write(JSON.stringify(out));
  } else if (cmd === 'done') {
    await q.updateOne({ _id: new (require('mongodb').ObjectId)(a1) },
      { $set: { status: 'sent', sentAt: now }, $unset: { claimedAt: '' } });
    process.stdout.write('ok');
  } else if (cmd === 'fail') {
    // ⛔실패 사유에 본문·링크가 섞이지 않게 «짧게» 자른다(④)
    const reason = String(a2 || '').slice(0, 120);
    const d = await q.findOne({ _id: new (require('mongodb').ObjectId)(a1) }, { projection: { retryCount: 1 } });
    const next = (d && d.retryCount ? d.retryCount : 0) + 1;
    await q.updateOne({ _id: new (require('mongodb').ObjectId)(a1) }, {
      $set: { status: next >= MAX_RETRY ? 'failed' : 'pending', retryCount: next, lastError: reason, lastTriedAt: now },
      $unset: { claimedAt: '' },
    });
    process.stdout.write(next >= MAX_RETRY ? 'failed' : 'requeued');
  } else if (cmd === 'sweep') {
    const r = await q.updateMany(staleMailFilter(now), { $set: { status: 'expired', expiredAt: now } });
    process.stdout.write(String(r.modifiedCount));
  } else if (cmd === 'stat') {
    const rows = await q.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]).toArray();
    process.stdout.write(JSON.stringify(rows.reduce((o, r) => (o[r._id || 'null'] = r.n, o), {})));
  } else {
    process.stderr.write('사용: claim|done|fail|sweep|stat');
    process.exitCode = 2;
  }
  await c.close();
}
main().catch((e) => { process.stderr.write('ERR ' + (e && e.message)); process.exit(1); });
