#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
   issue-reset-link.mjs — 비밀번호 재설정 «링크»를 손으로 뽑는다.
   ───────────────────────────────────────────────────────────────────────────
   ★왜 필요한가
     이 조직엔 mail_queue 를 꺼내 «실제로 보내는» 주체가 코드에도 서버에도 없다
     (2026-09-02 실측: 큐의 4통이 08-14부터 pending). 그래서 data/flags.json 의
     mailerLive 가 false 이고, reset-request.js 는 토큰만 만들고 메일을 큐에 넣지 않는다.
     ⇒ 그 동안의 «전달 경로»가 이 스크립트다. 담당자가 링크를 뽑아 답장에 붙인다.

   ★왜 엔드포인트가 아닌가
     「아무나 부르면 남의 재설정 링크가 나오는 URL」은 그 자체가 계정탈취 도구다.
     운영자 손으로만 도는 CLI 면 새 공개 표면이 0 이다. (promote-plan.mjs 와 같은 판단)

   ★안전장치 (promote-plan.mjs 의 관습을 그대로 따른다)
     - 기본이 «드라이런». 실제로 쓰려면 --apply 를 붙여야 한다.
     - 프로덕션 DB 를 건드리려면 --prod 까지 붙여야 한다(기본은 dev DB).
     - DB 에는 «해시»만 들어간다. 평문 토큰은 이 화면에만 존재하고 어디에도 안 남는다.
     - ⛔메일을 보내지 않는다. 보내는 척도 하지 않는다.
     - 없는 계정·미인증 계정에는 발급하지 않는다(엔드포인트와 «같은» 규칙).

   ⚠️출력에 «살아 있는 재설정 링크»가 들어 있다.
     터미널 로그·스크린샷·채팅 붙여넣기에 그대로 남는다는 뜻이다. 전달한 뒤에는
     그 흔적을 지우고, 링크는 본인 «가입 주소»로만 보낸다.

   사용:
     MONGO_URI=... node scripts/issue-reset-link.mjs --email a@b.com
     MONGO_URI=... node scripts/issue-reset-link.mjs --email a@b.com --apply --prod
     MONGO_URI=... node scripts/issue-reset-link.mjs --email a@b.com --apply --prod --ttl-minutes 720
     MONGO_URI=... node scripts/issue-reset-link.mjs --pending          (미처리 접수 목록)
═══════════════════════════════════════════════════════════════════════════ */
import { MongoClient } from 'mongodb';
import crypto from 'crypto';

function arg(name, def = null) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return (!v || v.startsWith('--')) ? true : v;
}

const APPLY = !!arg('apply', false);
const PROD = !!arg('prod', false);
const DB_NAME = PROD ? 'goditor_license' : 'goditor_license_dev';
const BASE = (arg('base') || process.env.LICENSE_BASE_URL || 'https://blacksheepwall.kr').replace(/\/$/, '');

// ★기본 수명은 엔드포인트와 «같은» 30분이다 — 두 경로가 다른 규칙을 쓰면
//   「화면엔 30분이라 적혀 있는데 실제론 아니었다」가 된다.
//   ⚠️다만 수동 전달 기간엔 담당자 회신이 30분 안에 안 될 수 있다. 그 경우
//     --ttl-minutes 720 처럼 «명시적으로» 늘려서 쓴다(현빈 확인사항 ⓕ-3).
//     기본값을 늘리지 않는 이유: 늘린 쪽이 «조용한 기본»이 되면 안 된다.
const TTL_MIN = Number(arg('ttl-minutes', 30));
if (!Number.isFinite(TTL_MIN) || TTL_MIN <= 0 || TTL_MIN > 24 * 60) {
  console.error('--ttl-minutes 는 1~1440 사이여야 한다.');
  process.exit(1);
}

const uri = process.env.MONGO_URI;
if (!uri) { console.error('MONGO_URI 가 없다. 이 스크립트는 URI 를 코드에 담지 않는다.'); process.exit(1); }

const client = new MongoClient(uri);
await client.connect();
const db = client.db(DB_NAME);
const users = db.collection('users');
const requests = db.collection('reset_requests');

const tag = `[${DB_NAME}]${APPLY ? '' : ' (드라이런 — 실제로 쓰려면 --apply)'}`;

try {
  /* ── 목록: 아직 회신 안 한 접수 ──
     ★담당자가 «놓친 요청»을 못 보는 것이 이 운영방식의 유일한 실패 모드다.
       메일러가 있으면 자동으로 나가지만, 지금은 사람이 이 목록을 봐야만 나간다. */
  if (arg('pending')) {
    const rows = await requests.find({ handledAt: null }).sort({ at: -1 }).limit(50).toArray();
    console.log(tag, `미처리 재설정 접수 ${rows.length}건`);
    for (const r of rows) {
      console.log(` ${new Date(r.at).toISOString().slice(0, 16).replace('T', ' ')}  ${r.email}`);
    }
    if (!rows.length) console.log(' (없음)');
    process.exit(0);
  }

  const email = String(arg('email') || '').trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    console.error('사용법: node scripts/issue-reset-link.mjs --email <가입 이메일> [--apply --prod]');
    process.exit(1);
  }

  const user = await users.findOne({ email }, { projection: { email: 1, verified: 1 } });
  if (!user) {
    // ★여기선 «있다/없다»를 그대로 말해도 된다 — 이 화면을 보는 사람은 운영자이지
    //   익명의 요청자가 아니다. 열거 방어는 «공개 엔드포인트»의 규칙이다.
    console.error(`${tag} 그런 계정이 없다: ${email}`);
    console.error('  ⇒ 링크를 만들지 않았다. 본인에게 «가입한 주소가 맞는지» 되물어야 한다.');
    process.exit(2);
  }
  if (!user.verified) {
    console.error(`${tag} 미인증 계정이라 발급하지 않는다: ${email}`);
    console.error('  ⇒ 여기서 발급하면 «메일 인증 없이 계정을 여는 뒷문»이 된다(엔드포인트와 같은 규칙).');
    process.exit(2);
  }

  const token = crypto.randomBytes(32).toString('hex');
  const resetTokenHash = crypto.createHash('sha256').update(token, 'utf8').digest('hex');
  const now = new Date();
  const resetTokenExpiresAt = new Date(now.getTime() + TTL_MIN * 60 * 1000);
  const resetUrl = `${BASE}/reset-password.html?token=${token}`;

  if (APPLY) {
    await users.updateOne({ email }, {
      $set: { resetTokenHash, resetTokenExpiresAt, resetRequestedAt: now, updatedAt: now },
    });
    // 접수가 남아 있으면 «처리했다»고 닫는다 — 다음 --pending 에서 또 뜨지 않게.
    await requests.updateMany(
      { email, handledAt: null },
      { $set: { handledAt: now, handledBy: 'issue-reset-link.mjs' } },
    );
  }

  console.log(tag);
  console.log(`  대상    : ${email}`);
  console.log(`  만료    : ${resetTokenExpiresAt.toISOString()}  (${TTL_MIN}분)`);
  console.log('  ─────────────────────────────────────────────────────────────');
  console.log(`  ${resetUrl}`);
  console.log('  ─────────────────────────────────────────────────────────────');
  if (!APPLY) {
    console.log('  ⚠️드라이런이라 DB 에 «쓰지 않았다» — 위 링크는 동작하지 않는다.');
    console.log('     실제 발급: 같은 명령에 --apply --prod 를 붙여라.');
  } else {
    console.log('  ⚠️이 링크는 «한 번만» 쓸 수 있고, 위 시각에 만료된다.');
    console.log('     본인의 «가입 주소»로만 보내라. 보낸 뒤 터미널 기록을 지워라.');
  }
} finally {
  await client.close();
}
