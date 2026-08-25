/* 앱별 자격(entitlements) — «어느 앱에서 어떤 등급인가»의 단일 진실.
 *
 * ★왜 (2026-08-25, 현빈 「앱별 개별판매」 확정 → 지디 스키마 확정)
 *   전엔 users.plan·accessUntil 이 «문서당 하나»(전역)뿐이라 「goditor 는 paid 인데 godiv 는 free」를
 *   표현할 수 없었다. 앱별로 팔려면 앱별 칸이 있어야 한다.
 *
 * 저장 모양 (additive — 기존 필드는 «건드리지 않는다»)
 *   users.plan / users.accessUntil        ← ⛔유지. 옛 배포본 앱이 이것만 읽는다. 지우지·개명하지 마라.
 *   users.entitlements = {                 ← 신규
 *     goditor: { plan, until },
 *     goshot:  { plan, until },
 *     godiv:   { plan, until },
 *   }
 *   · appId = 'goditor'|'goshot'|'godiv' 뿐. ⛔리뷰크롤러 제외(걔는 키 체계가 현역, 별도 컬렉션).
 *   · plan 값 = 'event_free'|'paid' 로 시작. 세분화는 나중에 additive 문자열 확장(지금 발명 금지).
 *   · until = ISO8601(또는 Date). 영구/기간 어느 쪽이든 담긴다.
 *
 * ★읽기 우선순위 = entitlements.<app> 있으면 그것, 없으면 구필드(plan/accessUntil) 폴백.
 *   전환기엔 «양쪽 다» 채운다 — 옛 앱은 구필드를, 새 앱은 entitlements 를 본다. 어느 쪽도 안 깨진다.
 *   구필드 제거는 ⛔별도 결정(옛 배포본이 다 사라졌다고 «확인»된 뒤).
 */

const APP_IDS = ['goditor', 'goshot', 'godiv'];
const PLAN_FREE = 'event_free';
const PLAN_PAID = 'paid';
const PAID_PLANS = ['paid', 'pro', 'premium']; // 확장 isPaid 와 «같은» 목록이어야 한다

function isPaidPlan(plan) {
  return PAID_PLANS.includes(String(plan || '').toLowerCase());
}

/** 정규화 — 화이트리스트 밖은 null(리뷰크롤러 등은 이 스키마에 편입 안 함). */
function normalizeAppId(app) {
  const s = typeof app === 'string' ? app.trim().toLowerCase() : '';
  return APP_IDS.includes(s) ? s : null;
}

/** 가입/이벤트 개방 시 세 앱을 «전부» 같은 무료 자격으로 채운다(현행 이벤트 = 전 앱 무료 개방과 동형). */
function eventEntitlements(until) {
  const e = {};
  for (const id of APP_IDS) e[id] = { plan: PLAN_FREE, until };
  return e;
}

/** 이 앱에서 «유효한» 자격을 계산한다. entitlements.<app> 우선, 없으면 구필드 폴백.
 *  @returns {{ plan, until, source }} source = 'entitlements'|'legacy' */
function effectiveFor(user, app) {
  const id = normalizeAppId(app);
  const ent = id && user && user.entitlements && user.entitlements[id];
  if (ent && typeof ent.plan === 'string') {
    return { plan: ent.plan, until: ent.until != null ? ent.until : null, source: 'entitlements' };
  }
  // 폴백 — 옛 문서(entitlements 없음)거나 화이트리스트 밖 app.
  return {
    plan: (user && user.plan) || PLAN_FREE,
    until: (user && user.accessUntil) || null,
    source: 'legacy',
  };
}

/** login/session 응답에 실을 entitlements 블록(그대로 있으면 그대로, 없으면 구필드로 합성).
 *  ⛔응답의 기존 필드(plan·accessUntil)를 «대체»하지 않는다 — 추가 필드로만 실어라(옛 앱 보호). */
function entitlementsForResponse(user) {
  if (user && user.entitlements && typeof user.entitlements === 'object') return user.entitlements;
  // 옛 문서 — 구필드를 세 앱에 비춰 «읽기용»으로만 합성(저장 아님).
  const until = (user && user.accessUntil) || null;
  const plan = (user && user.plan) || PLAN_FREE;
  const e = {};
  for (const id of APP_IDS) e[id] = { plan, until };
  return e;
}

module.exports = {
  APP_IDS, PLAN_FREE, PLAN_PAID, PAID_PLANS,
  isPaidPlan, normalizeAppId, eventEntitlements, effectiveFor, entitlementsForResponse,
};
