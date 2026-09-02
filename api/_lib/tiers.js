const TABLE = require('../../data/tiers.json');

/**
 * 앱별 «등급» 한 곳 (현빈 2026-09-02 설계).
 *
 * ★등급은 «숫자»가 진실이다. 별칭(BETA·INTERNSHIP·PRO…)은 화면에 보여줄 이름일 뿐이다.
 *   ⛔별칭으로 권한을 판정하지 마라 — 이름을 바꾸는 순간 권한이 바뀐다.
 *   숫자로 두면 `tier >= PRO` 한 줄로 끝나고, 등급이 늘어도 비교 코드가 안 늘어난다.
 *
 * ★번호 규칙
 *   0        guest (기본 — 아무 것도 안 산 상태)
 *   1~79     일반 등급. 숫자가 클수록 상위.
 *   80~98    운영(매니저)
 *   99       관리자
 *   ★★80 이상은 «구매로 도달할 수 없는» 자리다. 주문 코드가 그 범위를 쓰면
 *     돈을 내고 관리자가 되는 길이 열린다 — isPurchasable() 로 막는다.
 */

const GUEST = 0;
const STAFF_MIN = 80;      // 이 위는 «사람이 손으로만» 준다
const ADMIN = 99;

function appMeta(appId) {
  const t = TABLE[appId];
  if (!t) return null;
  return { id: appId, kind: t._유형 || 'app', name: t._이름 || appId.toUpperCase() };
}

/** 등급 번호 → 별칭. 앱 표에 없으면 공통 표를 보고, 그것도 없으면 «숫자 그대로» 돌려준다. */
function alias(appId, tier) {
  const n = Number(tier);
  if (!Number.isFinite(n)) return null;
  const t = TABLE[appId] || {};
  const key = String(n);
  return t[key] || TABLE._common[key] || ('등급 ' + key);
}

/** 그 앱에 «정의된» 등급 번호 목록(운영 등급 제외). 오름차순. */
function tiersOf(appId) {
  const t = TABLE[appId] || {};
  return Object.keys(t)
    .filter((k) => /^\d+$/.test(k))
    .map(Number)
    .filter((n) => n < STAFF_MIN)
    .sort((a, b) => a - b);
}

/** ★돈으로 살 수 있는 등급인가 — 주문 코드가 «반드시» 이걸 통과시켜야 한다. */
function isPurchasable(appId, tier) {
  const n = Number(tier);
  return Number.isFinite(n) && n > GUEST && n < STAFF_MIN && tiersOf(appId).includes(n);
}

function isStaff(tier) { return Number(tier) >= STAFF_MIN; }
function isAdmin(tier) { return Number(tier) === ADMIN; }

/**
 * 계정에 붙는 «앱 번들»의 기본값.
 * ★지금은 전원 베타(현빈). 베타가 끝나면 여기 기본값을 GUEST 로 내리면
 *   새로 붙는 번들부터 guest 가 된다 — 기존 번들은 안 건드린다.
 */
const DEFAULT_TIER = 1;   // = BETA

function newBundle(appId, now) {
  const m = appMeta(appId);
  if (!m) return null;
  return {
    kind: m.kind,                 // 프로덕트 유형(앱/서비스)
    name: m.name,                 // 프로덕트 이름
    tier: DEFAULT_TIER,           // 등급 번호
    firstSeenAt: now,
    lastLoginAt: now,
    payment: null,                // 결제방식 — 구매가 붙으면 채운다
  };
}

module.exports = {
  TABLE, GUEST, STAFF_MIN, ADMIN, DEFAULT_TIER,
  appMeta, alias, tiersOf, isPurchasable, isStaff, isAdmin, newBundle,
};
