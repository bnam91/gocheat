#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
   promote-plan.mjs — 사용자 등급을 «올리는» 유일한 수단.
   ───────────────────────────────────────────────────────────────────────────
   ★왜 스크립트인가 (엔드포인트가 아니라)
     등급 승격은 «돈을 받은 뒤» 사람이 통장을 보고 판단하는 일이다. 무통장입금이라
     자동 확인이 불가능하다. 공개 엔드포인트로 만들면 «인증을 새로 설계»해야 하고
     그 자체가 새 공격면이다 — 하루 몇 건짜리 일에 그럴 이유가 없다.
     ⇒ 운영자가 손으로 돌리는 CLI. 새 공개 표면 0.

   ★왜 지금 필요한가 (긴급도)
     accessUntil 을 «쓰는» 코드가 signup.js 한 곳뿐이다(전수 확인). 즉 지금 이 서비스엔
     **등급을 올릴 방법이 아예 없다.** 전원이 event_free / accessUntil = EVENT_UNTIL
     (기본 2026-12-31)이고, 그날이 지나면 **전원이 잠기고 복구 경로가 0이다.**
     이 스크립트가 그 복구 경로다.

   ★안전장치
     - 기본이 «드라이런»이다. 실제로 쓰려면 --apply 를 붙여야 한다.
     - 프로덕션 DB 를 건드리려면 --prod 까지 붙여야 한다(기본은 dev DB).
     - 멱등: 이미 같은 값이면 안 쓴다. 되돌리기 쉽게 이전 값을 audit 에 남긴다.
     - ⛔accessUntil 을 «줄이는» 방향은 거부한다(실수로 남의 이용기간을 깎지 않게).

   사용:
     MONGO_URI=... node scripts/promote-plan.mjs --list-orders
     MONGO_URI=... node scripts/promote-plan.mjs --email a@b.com --plan pro --until 2027-08-15
     MONGO_URI=... node scripts/promote-plan.mjs --order GD260815-0001 --apply --prod
═══════════════════════════════════════════════════════════════════════════ */
import { MongoClient } from 'mongodb';

const PLANS = ['event_free', 'free', 'starter', 'pro', 'promax'];

function arg(name, def = null) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return (!v || v.startsWith('--')) ? true : v;
}
const APPLY = !!arg('apply', false);
const PROD = !!arg('prod', false);
const DB_NAME = PROD ? 'goditor_license' : 'goditor_license_dev';

const uri = process.env.MONGO_URI;
if (!uri) { console.error('MONGO_URI 가 없다. 이 스크립트는 URI 를 코드에 담지 않는다.'); process.exit(1); }

const client = new MongoClient(uri);
await client.connect();
const db = client.db(DB_NAME);
const users = db.collection('users');
const orders = db.collection('orders');
const audit = db.collection('plan_audit');

const tag = `[${DB_NAME}]${APPLY ? '' : ' (드라이런 — 실제로 쓰려면 --apply)'}`;

try {
  /* ── 목록: 입금대기 주문 ── */
  if (arg('list-orders')) {
    const rows = await orders.find({ status: { $ne: 'paid' } }).sort({ createdAt: -1 }).limit(30).toArray();
    console.log(tag, `미확정 주문 ${rows.length}건`);
    for (const o of rows) {
      console.log(` ${o.orderNo}  ${o.status.padEnd(16)} ${o.plan.padEnd(8)} ${o.email}  입금자=${o.depositor}  ${new Date(o.createdAt).toISOString().slice(0, 10)}`);
    }
    process.exit(0);
  }

  /* ── 대상 결정: --order 이거나 --email + --plan ── */
  let email = arg('email');
  let plan = arg('plan');
  let orderNo = arg('order');
  let order = null;

  if (orderNo) {
    order = await orders.findOne({ orderNo });
    if (!order) { console.error('주문 없음:', orderNo); process.exit(2); }
    email = order.email; plan = order.plan;
  }
  if (!email || !plan) {
    console.error('--order <번호> 또는 --email <메일> --plan <등급> 이 필요하다. 등급:', PLANS.join('/'));
    process.exit(2);
  }
  if (!PLANS.includes(plan)) { console.error('모르는 등급:', plan, '· 가능:', PLANS.join('/')); process.exit(2); }

  const user = await users.findOne({ email });
  if (!user) { console.error('그런 계정이 없다:', email, '— 먼저 가입해야 한다'); process.exit(2); }

  /* ── 이용기간: --until 없으면 «오늘부터 1년» ── */
  const untilArg = arg('until');
  const until = untilArg && untilArg !== true
    ? new Date(untilArg + 'T14:59:59Z')                 // KST 자정 직전에 맞춘다(login.js 규칙과 동일한 UTC 저장)
    : new Date(Date.now() + 365 * 86400000);
  if (isNaN(until)) { console.error('--until 형식은 YYYY-MM-DD'); process.exit(2); }

  const cur = user.accessUntil ? new Date(user.accessUntil) : null;
  // ⛔줄이는 방향은 막는다 — 실수로 남의 이용기간을 깎지 않게. 정말 줄이려면 --force.
  if (cur && until < cur && !arg('force')) {
    console.error(`거부: 이용기간이 «줄어든다» (${cur.toISOString().slice(0, 10)} → ${until.toISOString().slice(0, 10)}). 정말이면 --force`);
    process.exit(3);
  }
  const noop = user.plan === plan && cur && Math.abs(cur - until) < 1000;

  console.log(tag);
  console.log(` 대상   : ${email}`);
  console.log(` 등급   : ${user.plan || '(없음)'} → ${plan}`);
  console.log(` 기간   : ${cur ? cur.toISOString().slice(0, 10) : '(없음)'} → ${until.toISOString().slice(0, 10)}`);
  if (order) console.log(` 주문   : ${order.orderNo} (${order.status} → paid)`);
  if (noop) { console.log(' ⇒ 이미 같은 값이다. 아무것도 안 한다.'); process.exit(0); }
  if (!APPLY) { console.log(' ⇒ 드라이런이라 여기서 멈춘다. --apply 를 붙이면 실제로 쓴다.'); process.exit(0); }

  const now = new Date();
  await users.updateOne({ email }, { $set: { plan, accessUntil: until, updatedAt: now } });
  if (order) await orders.updateOne({ orderNo: order.orderNo }, { $set: { status: 'paid', confirmedAt: now } });
  // ★되돌릴 수 있게 «이전 값»을 남긴다. 이게 없으면 잘못 올렸을 때 원상복구가 추측이 된다.
  await audit.insertOne({
    email, at: now, by: process.env.USER || 'unknown', orderNo: order ? order.orderNo : null,
    before: { plan: user.plan || null, accessUntil: cur },
    after: { plan, accessUntil: until },
  });
  const after = await users.findOne({ email }, { projection: { _id: 0, plan: 1, accessUntil: 1 } });
  console.log(' ✅ 적용됨 · 재조회:', JSON.stringify(after));
  console.log(' ⚠️ 사용자 앱에는 «등급 새로고침»을 눌러야 반영된다(또는 다음 부팅).');
} finally {
  await client.close();
}
