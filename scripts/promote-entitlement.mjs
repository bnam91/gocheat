/* 앱별 자격(entitlement) «운영자 승격» — 무통장입금 확인 뒤 손으로 여는 도구. (2026-08-25, ③-2)
 *
 * ★설계 규약 (지디)
 *   · 승격은 «운영자 액션»이다 — ⛔자동 입금매칭(은행 스크래핑 등) 아님. 그건 별도 결정.
 *   · 파이프: 주문(awaiting_deposit) → [사람이 입금 확인] → 이 스크립트 → entitlements.<app>=paid + until → order completed.
 *   · ★멱등: 두 번 돌려도 한 번 승격과 같은 결과. 감사로그(entitlement_audit)에 전/후 스냅샷.
 *   · additive: 기존 plan/accessUntil 은 «건드리지 않는다»(구필드 유지). entitlements.<app> «만» 쓴다.
 *     ⇒ 옛 배포본 앱은 여전히 구필드를 보고, 새 앱은 entitlements 를 본다. 어느 쪽도 안 깨진다.
 *   · until:null = 무기한. ⛔far-future 매직넘버 금지. 기간이 있으면 --until YYYY-MM-DD, 무기한이면 --forever.
 *   · ⛔기본 dry-run. --apply 명시해야 쓴다. --prod 로 라이브 DB(기본은 _dev).
 *
 * 사용:
 *   MONGO_URI=... node scripts/promote-entitlement.mjs --list-orders
 *   MONGO_URI=... node scripts/promote-entitlement.mjs --email a@b.com --app godiv --until 2027-08-15
 *   MONGO_URI=... node scripts/promote-entitlement.mjs --order GD260815-0001 --forever --apply --prod
 */
import { MongoClient } from 'mongodb';

const APP_IDS = ['goditor', 'goshot', 'godiv'];   // ⛔리뷰크롤러 제외(키 체계 현역)
const PLAN_PAID = 'paid';

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
const audit = db.collection('entitlement_audit');
const tag = `[${DB_NAME}]${APPLY ? '' : ' (드라이런 — 실제로 쓰려면 --apply)'}`;

try {
  if (arg('list-orders')) {
    const rows = await orders.find({ status: { $ne: 'completed' } }).sort({ createdAt: -1 }).limit(30).toArray();
    console.log(tag, `미완료 주문 ${rows.length}건`);
    for (const o of rows) {
      console.log(` ${o.orderNo}  ${String(o.status).padEnd(16)} ${String(o.plan || o.app || '?').padEnd(8)} ${o.email}  입금자=${o.depositor}  ${new Date(o.createdAt).toISOString().slice(0, 10)}`);
    }
    process.exit(0);
  }

  /* 대상 = --order 또는 --email + --app */
  let email = arg('email');
  let app = arg('app');
  const orderNo = arg('order');
  let order = null;
  if (orderNo) {
    order = await orders.findOne({ orderNo });
    if (!order) { console.error('주문 없음:', orderNo); process.exit(2); }
    email = order.email;
    app = app || order.app || order.plan; // 주문에 앱이 어떤 필드로 담겼든 받아준다
  }
  if (!email || !app) { console.error('--order <번호> 또는 --email <메일> --app <goditor|goshot|godiv>'); process.exit(2); }
  app = String(app).trim().toLowerCase();
  if (!APP_IDS.includes(app)) { console.error('모르는 앱:', app, '· 가능:', APP_IDS.join('/'), '(리뷰크롤러는 이 도구 대상 아님)'); process.exit(2); }

  const user = await users.findOne({ email });
  if (!user) { console.error('그런 계정이 없다:', email, '— 먼저 가입해야 한다'); process.exit(2); }

  /* until: --forever → null(무기한), --until YYYY-MM-DD → 그 날, 둘 다 없으면 «오늘부터 1년»(운영자 확인용 기본 제안) */
  let until;
  if (arg('forever')) until = null;
  else {
    const u = arg('until');
    if (u && u !== true) {
      until = new Date(u + 'T14:59:59Z');           // KST 자정 직전 = login.js 규칙과 동일 UTC 저장
      if (isNaN(until)) { console.error('--until 형식은 YYYY-MM-DD (무기한은 --forever)'); process.exit(2); }
    } else {
      until = new Date(Date.now() + 365 * 86400000); // 기본 제안 1년
    }
  }

  const before = (user.entitlements && user.entitlements[app]) || null;
  const beforeUntil = before && before.until ? new Date(before.until) : null;

  // ⛔줄이는 방향(기간 단축·강등)은 --force 없이는 막는다 — 실수로 남의 것 깎지 않게. 무기한(null)은 항상 «늘리는» 것.
  if (before && before.plan === PLAN_PAID && until && beforeUntil && until < beforeUntil && !arg('force')) {
    console.error(`거부: 이용기간이 «줄어든다» (${beforeUntil.toISOString().slice(0,10)} → ${until.toISOString().slice(0,10)}). 정말이면 --force`);
    process.exit(3);
  }

  // 멱등 판정: 이미 paid + 같은 until 이면 아무것도 안 한다.
  const sameUntil = (!before?.until && until === null) || (before?.until && until && Math.abs(new Date(before.until) - until) < 1000);
  const noop = before && before.plan === PLAN_PAID && sameUntil;

  console.log(tag);
  console.log(` 대상   : ${email}  ·  앱: ${app}`);
  console.log(` 등급   : ${before ? before.plan : '(자격 없음)'} → ${PLAN_PAID}`);
  console.log(` 기간   : ${before ? (before.until ? new Date(before.until).toISOString().slice(0,10) : '무기한') : '(없음)'} → ${until ? until.toISOString().slice(0,10) : '무기한'}`);
  if (order) console.log(` 주문   : ${order.orderNo} (${order.status} → completed)`);
  console.log(` ⛔구필드(plan/accessUntil)는 건드리지 않는다(additive).`);
  if (noop) { console.log(' ⇒ 이미 같은 값이다(멱등). 아무것도 안 한다.'); process.exit(0); }
  if (!APPLY) { console.log(' ⇒ 드라이런. --apply 를 붙이면 실제로 쓴다.'); process.exit(0); }

  const now = new Date();
  await users.updateOne({ email }, { $set: {
    [`entitlements.${app}.plan`]: PLAN_PAID,
    [`entitlements.${app}.until`]: until,        // null 이면 무기한으로 저장된다
    [`entitlements.${app}.source`]: order ? `order:${order.orderNo}` : 'manual',
    [`entitlements.${app}.updatedAt`]: now,
    updatedAt: now,
  } });
  if (order) await orders.updateOne({ orderNo: order.orderNo }, { $set: { status: 'completed', confirmedAt: now } });
  await audit.insertOne({
    at: now, email, app, action: 'promote', to: { plan: PLAN_PAID, until },
    before, orderNo: order ? order.orderNo : null, by: process.env.USER || 'unknown',
  });
  console.log(' ✅ 승격 완료(감사로그 entitlement_audit 기록).');
} finally {
  await client.close();
}
