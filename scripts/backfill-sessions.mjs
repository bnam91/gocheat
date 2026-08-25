/* 기존 로그인 유저의 구식 토큰을 sessions[] 로 «옮겨 담는» 일회성 스크립트.
 *
 * ★왜 필요한가 (2026-08-25)
 *   제품별 세션(api/_lib/sessions.js)으로 바꾸면서, 로그인할 때 자동으로 백필하도록 만들었다.
 *   그것만으로도 «튕김»은 안 생긴다 — 문제의 순간이 바로 그 로그인 순간이라 자동 백필이 그때 걸리기 때문이다.
 *   그래도 이 스크립트를 두는 이유: ★배포 «직후»부터 전원이 안전한 상태이길 원하면, 로그인을 기다리지 않고 미리 옮겨 둔다.
 *   (자동 백필이 있으므로 이 스크립트는 «선택»이다. 안 돌려도 동작은 맞다.)
 *
 * ⛔기본은 dry-run 이다. 실제로 쓰려면 --apply 를 «명시»해야 한다.
 *   DB를 건드리는 스크립트가 기본값으로 쓰기를 하면, 실수로 한 번 돈 것이 되돌릴 수 없는 일이 된다.
 *
 * 실행:
 *   MONGO_URI=... MONGO_DB=goditor_license node scripts/backfill-sessions.mjs           # 몇 명이 대상인지만 본다
 *   MONGO_URI=... MONGO_DB=goditor_license node scripts/backfill-sessions.mjs --apply   # 실제로 옮긴다
 *
 * 무엇을 하나:
 *   sessionToken 이 있는데 sessions[] 에 그 토큰이 «없는» 사용자에게
 *   sessions += { app:'_backfill', token: <구식 토큰>, issuedAt: <sessionIssuedAt 또는 지금>, backfilled: true }
 *   ★이미 옮겨진 사람은 건너뛴다(멱등) — 여러 번 돌려도 칸이 늘지 않는다.
 *   ⛔토큰을 «새로 발급하지 않는다». 발급하면 그 순간 모두가 로그아웃된다 — 정확히 피하려던 그 사고다.
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { MongoClient } = require('mongodb');

const APPLY = process.argv.includes('--apply');
const URI = process.env.MONGO_URI || process.env.MONGODB_URI;
const DBN = process.env.MONGO_DB || 'goditor_license';
/* ★예약 칸 — api/_lib/sessions.js 의 BACKFILL_APP 과 «같은 값»이어야 한다.
 *   'legacy' 로 넣으면 app 을 안 보내는 클라이언트가 로그인하는 순간 그 칸이 걷혀 백필이 무효가 된다
 *   (2026-08-25 2차 검수 H1). 클라이언트는 '_' 로 시작하는 이름을 만들 수 없어 이 칸을 못 건드린다. */
const BACKFILL_APP = '_backfill';

if (!URI) {
  console.error('⛔ MONGO_URI 가 없다. 예: MONGO_URI="mongodb+srv://…" node scripts/backfill-sessions.mjs');
  process.exit(1);
}

const client = await MongoClient.connect(URI);
try {
  const users = client.db(DBN).collection('users');
  // 대상 = 구식 토큰이 있고, 그 토큰이 sessions[] 어디에도 없는 사람
  const cursor = users.find(
    { sessionToken: { $type: 'string', $ne: '' } },
    { projection: { email: 1, sessionToken: 1, sessionIssuedAt: 1, sessions: 1 } },
  );

  let total = 0, target = 0, done = 0;
  const now = new Date();
  for await (const u of cursor) {
    total++;
    const has = Array.isArray(u.sessions) && u.sessions.some((s) => s && s.token === u.sessionToken);
    if (has) continue;
    target++;
    if (!APPLY) continue;
    const r = await users.updateOne(
      // ★조건을 «갱신 시점에» 다시 건다 — 읽고 쓰는 사이에 그 사람이 로그인해 이미 백필됐을 수 있다.
      { email: u.email, sessionToken: u.sessionToken, 'sessions.token': { $ne: u.sessionToken } },
      { $push: { sessions: { app: BACKFILL_APP, token: u.sessionToken, issuedAt: u.sessionIssuedAt || now, backfilled: true } } },
    );
    if (r.modifiedCount) done++;
  }

  console.log(`구식 토큰 보유자 ${total}명 · 옮길 대상 ${target}명 · ${APPLY ? `실제 반영 ${done}명` : '반영 0명(dry-run)'}`);
  if (!APPLY && target > 0) console.log('→ 실제로 옮기려면 --apply 를 붙여 다시 실행하라.');
} finally {
  await client.close();
}
