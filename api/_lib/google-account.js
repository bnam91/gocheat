/* 구글이 확인해 준 신원을 «우리 계정»에 앉히는 곳.
 *
 * ★설계 원칙(signup.js 에서 그대로 가져온다)
 *   자격증명과 신원은 «만들 때만» 쓴다($setOnInsert). 기존 문서는 덮지 않는다.
 *   signup.js 주석의 탈취 시나리오가 여기에도 그대로 적용된다 —
 *   「이미 있는 계정에 다른 사람이 자기 것을 덮어쓸 수 있는가」가 유일한 질문이다.
 *
 * ★★자동 연결이 «안전한» 이유는 하나뿐이다: 구글이 email_verified 로 «그 주소의 소유»를 확인해 줬고,
 *   우리 계정 키도 그 주소이기 때문이다. 그래서 email_verified 가 false 면 «연결하지 않는다».
 *   ⛔이 판정을 「구글에서 왔으니 믿는다」로 완화하지 마라. 구글 계정에는 «확인 안 된 주소»가 붙을 수 있다.
 *
 * ⛔카카오·네이버를 붙일 때 이 파일을 복사하지 마라.
 *   카카오는 이메일이 «선택 동의»라 아예 없을 수 있고, 검증 여부 보장도 다르다.
 *   즉 여기 3번 분기(자동 연결)가 성립하지 않는다. provider 만 늘리는 일이 아니다.
 */
const { getDb } = require('./mongo');
const { normalizeEmail, isValidEmail } = require('./util');

// signup.js 와 «같은 값»이어야 한다. 두 경로가 다른 기본값을 주면
// 「구글로 가입한 사람만 유효기간이 다른」 상태가 생긴다.
const EVENT_UNTIL = new Date(process.env.EVENT_UNTIL || '2026-12-31T23:59:59Z');

/* 반환 = { ok:true, email, created:boolean } | { ok:false, reason }
 *   created=true 면 «방금 만든 계정»이라 추가정보(휴대전화·동의)가 비어 있다.
 *   호출자는 그때만 추가정보 화면으로 보낸다. */
async function upsertFromGoogle(info) {
  // ── 1. 구글이 준 값을 «먼저» 검사한다 ──────────────────────────────
  if (!info || typeof info !== 'object') return { ok: false, reason: 'no_profile' };

  // ★email_verified 는 true(불리언) 또는 'true'(문자열)로 올 수 있다 — 엔드포인트마다 다르다.
  //   ⛔`if (info.email_verified)` 로 두면 문자열 'false' 가 «참»이 되어 그대로 통과한다.
  const verified = info.email_verified === true || info.email_verified === 'true';
  if (!verified) return { ok: false, reason: 'google_email_unverified' };

  const email = normalizeEmail(info.email);
  if (!isValidEmail(email)) return { ok: false, reason: 'no_email' };

  const sub = typeof info.sub === 'string' ? info.sub.trim() : '';
  if (!sub) return { ok: false, reason: 'no_sub' };

  const db = await getDb();
  const users = db.collection('users');
  const now = new Date();

  // ── 2. 있으면 연결, 없으면 만든다 ─────────────────────────────────
  const existing = await users.findOne(
    { email },
    { projection: { email: 1, googleSub: 1, verified: 1, passwordHash: 1, profile: 1, consents: 1 } },
  );

  if (!existing) {
    /* ★upsert 로 «만들기»만 한다.
       동시에 같은 사람이 두 번 눌러도 email unique 인덱스가 하나로 접는다.
       ⚠️여기서 profile·consents 를 «비워 두는 게 맞다» — 구글은 휴대전화를 주지 않고,
         약관 동의는 우리가 받아야 한다(개인정보 보호법 제22조① 구분 동의).
         빈 채로 두고 추가정보 화면에서 채운다. */
    try {
      await users.updateOne(
        { email },
        {
          $setOnInsert: {
            email,
            createdAt: now,
            plan: 'event_free',
            accessUntil: EVENT_UNTIL,
            // ★구글이 확인해 준 주소라 인증메일이 필요 없다. 그래서 verificationToken 도 안 만든다.
            verified: true,
            verifiedAt: now,
            provider: 'google',
            googleSub: sub,
            googleLinkedAt: now,
          },
          $set: { updatedAt: now },
        },
        { upsert: true },
      );
    } catch (err) {
      // 경쟁에서 졌다(같은 순간 다른 요청이 먼저 만들었다) — 아래 연결 경로로 떨어뜨린다.
      if (err && err.code !== 11000) throw err;
    }
    const made = await users.findOne({ email }, { projection: { googleSub: 1, profile: 1, consents: 1 } });
    // 내가 만든 게 아니라 «졌던» 경우엔 sub 가 다를 수 있다 — 아래와 같은 규칙으로 본다.
    if (made && made.googleSub && made.googleSub !== sub) {
      return { ok: false, reason: 'account_conflict' };
    }
    return { ok: true, email, created: !(made && made.profile) };
  }

  // ── 3. 이미 있는 계정 ────────────────────────────────────────────
  if (existing.googleSub === sub) {
    await users.updateOne({ email }, { $set: { updatedAt: now } });
    return { ok: true, email, created: false };
  }

  if (existing.googleSub && existing.googleSub !== sub) {
    /* 같은 이메일인데 «다른 구글 계정»이다. 일어나면 안 되는 조합이고,
       조용히 덮으면 그게 계정 탈취다. 사람이 봐야 하는 상태이므로 거절한다. */
    return { ok: false, reason: 'account_conflict' };
  }

  /* ★이메일로 먼저 가입한 사람에게 구글을 «붙인다».
     조건을 «쿼리에» 넣어야 원자적이다 — 코드에서 if 로 판단하면
     읽고 쓰는 사이에 다른 요청이 끼어들 수 있다. */
  const r = await users.updateOne(
    { email, googleSub: { $exists: false } },
    {
      $set: {
        googleSub: sub,
        googleLinkedAt: now,
        updatedAt: now,
        /* ★구글이 확인해 준 주소이므로 «미인증 계정도 여기서 인증된다».
           이건 완화가 아니라 그 반대다 — 이메일 인증 링크와 «같은 것»을 증명한 것이고,
           오히려 구글 쪽이 더 강하다(2단계 인증까지 통과한 계정이다).
           ⚠️단 passwordHash 는 «건드리지 않는다». 비밀번호는 원래 주인 것이다. */
        verified: true,
        ...(existing.verifiedAt ? {} : { verifiedAt: now }),
      },
    },
  );

  if (!r.matchedCount) {
    // 붙이는 사이에 누가 먼저 붙였다 — 그게 나와 같은 sub 면 정상, 아니면 충돌.
    const again = await users.findOne({ email }, { projection: { googleSub: 1 } });
    if (!again || again.googleSub !== sub) return { ok: false, reason: 'account_conflict' };
  }

  /* ★기존 계정이라도 추가정보가 «비어 있으면» 채우러 보낸다.
     extendedSignup 이 열리기 «전»에 가입한 사람들은 profile 이 없다 —
     그들을 그냥 통과시키면 영영 연락처가 없는 회원으로 남는다. */
  return { ok: true, email, created: false, needsProfile: !existing.profile };
}

module.exports = { upsertFromGoogle, EVENT_UNTIL };
