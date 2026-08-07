/**
 * 등급 판정 — «여기 한 곳»에서만 정한다.
 *
 * ★★베타는 «등급»이 아니라 «기간»이다.
 *   계정마다 종료일을 박으면 베타를 «연장»할 때 가입한 전원을 고쳐야 한다(= 마이그레이션).
 *   BETA_UNTIL 한 곳만 보면 종료도 연장도 «계정 0건 수정»으로 끝난다.
 *
 * ★계정엔 「산 것」만 적는다.
 *   가입(소문의섬)은 어느 앱을 쓸지 모르므로 아무 등급도 안 박는다.
 *   앱에 «처음 로그인할 때» users.apps.<앱> 이 생긴다 = 「그 앱의 유저」 등록.
 *
 *   users {
 *     email, passwordHash, verified, createdAt,      ← 소문의섬 계정(앱 무관)
 *     apps: { goditor: { firstSeenAt, plan:'free', accessUntil:null } },
 *     downloads: { goditor: { lastAt } }
 *   }
 */

// EVENT_UNTIL 은 옛 이름 — 환경변수를 아직 안 바꿨어도 동작하게 둘 다 본다.
const BETA_UNTIL = new Date(
  process.env.BETA_UNTIL || process.env.EVENT_UNTIL || '2026-12-31T23:59:59Z'
);

const APPS = new Set(['goditor']);                    // 앱이 늘면 여기에 추가
const PAID = new Set(['starter', 'pro', 'promax']);   // 요금표의 유료 등급(FREE 는 «안 산 것»)

/** 남이 준 값이다 — 아는 앱 id 가 아니면 null. 그래야 apps.<아무거나> 가 안 만들어진다. */
function normalizeAppId(v) {
  const s = String(v == null ? '' : v).toLowerCase().trim();
  return APPS.has(s) ? s : null;
}

function resolvePlan(user, appId, now = new Date()) {
  const a = (user && user.apps && user.apps[appId]) || null;
  const until = a && a.accessUntil ? new Date(a.accessUntil) : null;
  const bought = a && PAID.has(a.plan) ? a.plan : null;   // ★모르는 값은 «산 것 아님»

  // 베타 기간엔 계정을 보지도 않는다. 전원이 베타 권한.
  if (now.getTime() < BETA_UNTIL.getTime()) {
    return { plan: 'beta', source: 'beta', accessUntil: BETA_UNTIL, registered: !!a };
  }
  // ★만료 = 「차단」이 아니라 「강등」이다. FREE 가 있는 제품의 정상 동작.
  if (bought && until && until.getTime() > now.getTime()) {
    return { plan: bought, source: 'paid', accessUntil: until, registered: true };
  }
  return { plan: 'free', source: 'free', accessUntil: until, expiredFrom: bought, registered: !!a };
}

/**
 * 앱 첫 로그인 = 그 앱의 유저로 등록. 이미 있으면 «아무것도 안 한다»(등급을 덮지 않는다).
 * ★조건을 «필터»에 둔다 — 읽고→없으면→쓰기 로 하면 동시 로그인에 두 번 만들어진다.
 * @returns {boolean} 이번에 «처음» 등록됐으면 true
 */
async function registerApp(db, email, appId) {
  const r = await db.collection('users').updateOne(
    { email, ['apps.' + appId]: { $exists: false } },
    { $set: { ['apps.' + appId]: { firstSeenAt: new Date(), plan: 'free', accessUntil: null } } }
  );
  return (r.modifiedCount || 0) > 0;
}

module.exports = { BETA_UNTIL, APPS, PAID, normalizeAppId, resolvePlan, registerApp };
