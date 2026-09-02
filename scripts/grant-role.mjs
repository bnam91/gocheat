#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
   grant-role.mjs — 계정에 «역할(role)»을 주는 유일한 수단.
   ───────────────────────────────────────────────────────────────────────────
   ★왜 스크립트인가 (엔드포인트가 아니라)
     role='admin' 은 «전체 사용자에게 모달을 띄울 수 있는» 권한이다. 이걸 주는 문을
     웹에 내면 그 문 자체가 최우선 공격 표적이 된다. 하루 한 번도 안 쓰는 일에
     새 공개 표면을 만들 이유가 없다 — 운영자가 손으로 돌리는 CLI 로 둔다.
     (promote-plan.mjs 와 «같은 꼴»이다. 성격이 같은 도구는 같게 둔다.)

   ★안전장치 (promote-plan.mjs 와 동일)
     - 기본이 «드라이런». 실제로 쓰려면 --apply.
     - 프로덕션 DB 를 건드리려면 --prod 까지. 기본은 dev DB.
     - 이전 값을 role_audit 에 남긴다(누가 언제 누구에게 줬는지).
     - 멱등: 이미 같은 값이면 안 쓴다.

   사용:
     # ①먼저 확인 (아무것도 안 씀)
     MONGO_URI=... node scripts/grant-role.mjs --email coq3820@gmail.com --role admin --prod
     # ②실제 부여
     MONGO_URI=... node scripts/grant-role.mjs --email coq3820@gmail.com --role admin --prod --apply
     # ③회수
     MONGO_URI=... node scripts/grant-role.mjs --email coq3820@gmail.com --role none --prod --apply
     # 현재 어드민 목록
     MONGO_URI=... node scripts/grant-role.mjs --list --prod
═══════════════════════════════════════════════════════════════════════════ */
import { MongoClient } from 'mongodb';

const ROLES = ['admin', 'none'];   // 'none' = 필드를 «지운다»(일반 사용자). ⛔'user' 를 채워 넣지 않는다.

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
const audit = db.collection('role_audit');

const tag = `[${DB_NAME}]${APPLY ? '' : ' (드라이런 — 실제로 쓰려면 --apply)'}`;

try {
  if (arg('list')) {
    const rows = await users.find({ role: { $exists: true, $ne: null } })
      .project({ email: 1, role: 1, lastLoginAt: 1 }).toArray();
    console.log(tag, `역할이 있는 계정 ${rows.length}건`);
    for (const u of rows) console.log(` ${String(u.role).padEnd(8)} ${u.email}`);
    process.exit(0);
  }

  const email = String(arg('email') || '').trim().toLowerCase();
  const role = String(arg('role') || '').trim().toLowerCase();
  if (!email || !ROLES.includes(role)) {
    console.error('사용: --email <주소> --role admin|none [--prod] [--apply]');
    process.exit(1);
  }

  const user = await users.findOne({ email }, { projection: { email: 1, role: 1, verified: 1 } });
  if (!user) { console.error(`${tag} 그런 계정이 없다: ${email}`); process.exit(1); }

  const before = user.role || null;
  const after = role === 'none' ? null : role;
  console.log(`${tag} ${email}  role: ${before || '(없음)'} → ${after || '(없음)'}  verified=${!!user.verified}`);

  if (!user.verified && after === 'admin') {
    // ★미인증 계정에 어드민을 주면 로그인 자체가 403 이라 «권한은 있는데 못 쓰는» 상태가 된다.
    console.error('⛔이 계정은 이메일 미인증이다. 인증을 먼저 끝내라.');
    process.exit(1);
  }
  if (before === after) { console.log('이미 같은 값이다 — 아무것도 하지 않는다.'); process.exit(0); }
  if (!APPLY) { console.log('드라이런이라 여기서 멈춘다. 실제로 쓰려면 --apply 를 붙여라.'); process.exit(0); }

  const update = after ? { $set: { role: after } } : { $unset: { role: '' } };
  const r = await users.updateOne({ email }, update);
  await audit.insertOne({
    email, before, after, at: new Date(),
    by: process.env.SUDO_USER || process.env.USER || 'unknown',
    db: DB_NAME,
  });
  console.log(`완료 (matched=${r.matchedCount} modified=${r.modifiedCount}). role_audit 에 기록했다.`);
  console.log('⚠️앱은 «다시 로그인»해야 role 이 실린 응답을 받는다(로그인·세션 응답에 실린다).');
} finally {
  await client.close();
}
