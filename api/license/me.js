const { getDb } = require('../_lib/mongo');
const { json, handlePreflight, readJsonBody } = require('../_lib/util');

/**
 * 마이페이지 «내 정보» 한 벌 — 이름·연락처 + 앱별 이용 현황.
 *
 * ★왜 session.js 를 늘리지 않았나: 그건 «앱이 라이선스를 확인할 때마다» 부르는 뜨거운 경로다.
 *   거기에 집계를 얹으면 화면 한 곳 때문에 앱 전체가 느려진다. 화면 전용 경로를 따로 둔다.
 *
 * ★★«없는 것을 지어내지 않는다».
 *   지금 서버에 실제로 쌓이는 사용 기록은 godiv_events «하나뿐»이다(2026-09-02 실측 17건).
 *   GODITOR·GOSHOT 은 실행 기록을 남기는 코드가 아예 없다 — 그래서 lastUsedAt 을 null 로 준다.
 *   화면은 그걸 「기록 없음」으로 그린다. 0 이나 오늘 날짜로 채우면 «거짓»이 된다.
 *
 * 입력  { sessionToken }
 * 출력  { ok, email, plan, accessUntil, profile:{name,phone}, apps:[…] }
 */

const tiers = require('../_lib/tiers');
// 사용 기록을 «실제로 남기는» 앱만 적는다. 없는 앱에 0 을 넣으면 「한 번도 안 썼다」는 거짓이 된다.
const USAGE_COLL = { godiv: 'godiv_events' };

// ★등급은 이제 «번들의 숫자»에서 온다(api/_lib/tiers.js).
//   계정 등급(user.plan)에서 파생하던 옛 방식은 걷어냈다 — 앱마다 등급이 다를 수 있게 됐기 때문이다.
//   ⚠️번들에 tier 가 «없는» 옛 계정은 베타(기본값)로 본다. 0(guest)으로 떨어뜨리면
//     지금 쓰고 있는 사람의 화면에서 갑자기 등급이 사라진다.

module.exports = async (req, res) => {
  if (handlePreflight(req, res, { origin: '*' })) return;
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });
  res.setHeader('Access-Control-Allow-Origin', '*');

  let body;
  try { body = await readJsonBody(req); }
  catch (err) { return json(res, 400, { error: 'invalid_body', detail: err.message }); }

  const sessionToken = typeof body.sessionToken === 'string' ? body.sessionToken.trim() : '';
  if (!sessionToken) return json(res, 401, { ok: false, reason: 'invalid_session' });

  try {
    const db = await getDb();
    // ★session.js 와 «같은 규칙»으로 찾는다 — 두 곳이 다르게 굴면 한쪽만 통과하는 상태가 생긴다.
    const user = await db.collection('users').findOne({ sessionToken });
    if (!user) return json(res, 401, { ok: false, reason: 'invalid_session' });
    if (!user.verified) return json(res, 403, { ok: false, reason: 'email_not_verified' });

    // ★★«이용 중인 앱»은 고정 목록이 아니라 «계정에 붙은 번들»이다(현빈 2026-09-02).
    //   앱에서 로그인하면 login.js 가 users.apps.<id> 를 만든다. 그 목록이 곧 이 사람이 쓰는 앱이다.
    //   ⇒ 안 써 본 앱을 「이용 중」이라고 하지 않는다.
    // ★번들이 아직 없는 «옛 계정»을 위해 다른 흔적도 같이 본다:
    //   users.downloads.<id>(다운로드 기록) 와 godiv_events(사용 기록). 그 셋의 합집합이다.
    const bundles = (user.apps && typeof user.apps === 'object') ? user.apps : {};
    const ids = new Set(Object.keys(bundles));
    if (user.downloads && typeof user.downloads === 'object') Object.keys(user.downloads).forEach((k) => ids.add(k));

    const usage = {};
    for (const [id, coll] of Object.entries(USAGE_COLL)) {
      const rows = await db.collection(coll).aggregate([
        { $match: { email: user.email } },
        { $group: { _id: null, n: { $sum: 1 }, last: { $max: '$at' } } },
      ]).toArray();
      if (rows.length) { usage[id] = { uses: rows[0].n, lastUsedAt: rows[0].last }; ids.add(id); }
    }

    const APPS = [...ids]
      .filter((id) => tiers.appMeta(id))     // 등급표에 없는 id 는 화면에 올리지 않는다
      .sort((a, b) => a.localeCompare(b));

    return json(res, 200, {
      ok: true,
      email: user.email,
      plan: user.plan || 'event_free',
      accessUntil: user.accessUntil || null,
      // ★이 사람이 «우리를 처음 만난 앱». 마케팅·지원 양쪽에서 쓰인다.
      firstAppId: user.firstAppId || null,
      firstAppAt: user.firstAppAt || null,
      // ⛔프로필은 «이름·연락처»만 준다. 해시·토큰은 절대 싣지 않는다.
      profile: {
        name: (user.profile && user.profile.name) || null,
        phone: (user.profile && user.profile.phone) || null,
      },
      apps: APPS.map((id) => {
        const b = bundles[id] || {};
        const meta = tiers.appMeta(id);
        const tier = Number.isFinite(Number(b.tier)) ? Number(b.tier) : tiers.DEFAULT_TIER;
        return {
          id,
          kind: b.kind || meta.kind,        // 프로덕트 유형(앱/서비스)
          name: b.name || meta.name,        // 프로덕트 이름
          tier,                             // ★등급 «번호» — 권한 판정은 이 값으로 한다
          label: tiers.alias(id, tier),     // 등급 «별칭» — 화면 표시용
          staff: tiers.isStaff(tier),       // 88·99 는 운영 계정이라 화면에서 티가 나야 한다
          // ★다음 등급이 있으면 «등급 올리기»가 의미 있다. 최고 등급이면 그 링크를 안 그린다.
          canUpgrade: tiers.tiersOf(id).some((n) => n > tier),
          payment: b.payment || null,       // 결제방식
          // ★«기록을 남기는 앱인지»를 화면에 알려준다. 「기록 없음」과 「아직 안 썼음」은 다른 사실이다.
          tracksUsage: !!USAGE_COLL[id],
          firstSeenAt: b.firstSeenAt || b.firstLoginAt || null,
          lastLoginAt: b.lastLoginAt || null,
          uses: usage[id] ? usage[id].uses : null,
          lastUsedAt: usage[id] ? usage[id].lastUsedAt : null,
        };
      }),
    });
  } catch (err) {
    console.error('[me] error', err && err.message);
    return json(res, 500, { ok: false, reason: 'internal_error' });
  }
};
