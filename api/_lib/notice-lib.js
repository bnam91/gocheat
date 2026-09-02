/* 공지(notices)의 «모양»과 «대상 판정» — 쓰는 쪽(POST /api/notice)과 읽는 쪽(GET /api/notice/current)이
 * 같은 규칙을 봐야 하므로 한 파일에 둔다. 두 벌이 되면 「보냈는데 안 뜬다」가 난다.
 *
 * 저장 모양
 *   { _id, title, body, level:'normal'|'urgent',
 *     target:{ kind:'all'|'version'|'plan', versions:[], versionBelow:'', plans:[], apps:[] },
 *     startAt, endAt, createdBy, createdAt, revoked:false, revokedAt }
 *
 * ★기간(startAt·endAt)은 «필수»다 (PLAN §5)
 *   기간 없는 공지는 「이미 업데이트한 사람에게 업데이트 안내」가 영원히 뜨는 상태를 만든다.
 *   ⇒ 서버가 입력 단계에서 막는다. 화면이 깜빡 잊어도 여기서 걸린다.
 *
 * ★level 은 2단뿐 (현빈 확정 2026-09-02): normal=토스트 / urgent=모달.
 *   ⛔3단계를 «발명»하지 마라. 화면 처리가 둘밖에 없다.
 */

const LEVELS = ['normal', 'urgent'];
const TARGET_KINDS = ['all', 'version', 'plan'];
const MAX_TITLE = 120;
const MAX_BODY = 4000;
const MAX_PERIOD_MS = 365 * 24 * 3600 * 1000;   // 1년 — 「영원히 뜨는 공지」를 구조적으로 막는다

/** '0.8.10' vs '0.8.9' 를 «숫자로» 비교한다. ⛔문자열 비교로 하면 0.8.10 < 0.8.9 가 된다. */
function cmpVersion(a, b) {
  const pa = String(a || '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '').split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** 입력 target 을 저장할 모양으로. 잘못된 입력은 { error, message } 를 돌려준다. */
function normalizeTarget(input) {
  const t = (input && typeof input === 'object') ? input : {};
  const kind = TARGET_KINDS.includes(String(t.kind || '').toLowerCase())
    ? String(t.kind).toLowerCase() : null;
  if (!kind) {
    return { error: 'bad_target', message: '대상을 고르세요(전체 / 특정 버전 / 특정 등급).' };
  }
  const apps = Array.isArray(t.apps)
    ? t.apps.map((s) => String(s).trim().toLowerCase()).filter(Boolean).slice(0, 10) : [];

  if (kind === 'version') {
    const versions = Array.isArray(t.versions)
      ? t.versions.map((s) => String(s).trim()).filter(Boolean).slice(0, 30) : [];
    const versionBelow = t.versionBelow ? String(t.versionBelow).trim() : '';
    if (!versions.length && !versionBelow) {
      return { error: 'bad_target',
        message: '버전 대상은 «해당 버전 목록» 또는 «이 버전 미만» 중 하나를 정해야 합니다.' };
    }
    return { target: { kind, versions, versionBelow, plans: [], apps } };
  }
  if (kind === 'plan') {
    const plans = Array.isArray(t.plans)
      ? t.plans.map((s) => String(s).trim().toLowerCase()).filter(Boolean).slice(0, 20) : [];
    if (!plans.length) return { error: 'bad_target', message: '등급 대상은 등급을 하나 이상 골라야 합니다.' };
    return { target: { kind, versions: [], versionBelow: '', plans, apps } };
  }
  return { target: { kind: 'all', versions: [], versionBelow: '', plans: [], apps } };
}

/** 이 공지가 «이 클라이언트»를 대상으로 하나. ⛔여기 하나로만 판정한다. */
function matchesTarget(notice, ctx) {
  const t = (notice && notice.target) || {};
  const apps = Array.isArray(t.apps) ? t.apps : [];
  // apps 가 비어 있으면 «모든 앱». 있으면 그 목록에 들어야 한다.
  if (apps.length && !apps.includes(String(ctx.app || '').toLowerCase())) return false;

  const kind = t.kind || 'all';
  if (kind === 'all') return true;

  if (kind === 'version') {
    const v = String(ctx.appVersion || '').trim();
    // ★버전을 «모르면» 버전 대상 공지는 안 보낸다. 모르는 채로 보내면 이미 고친 사람에게도 뜬다.
    if (!v) return false;
    if (Array.isArray(t.versions) && t.versions.length) return t.versions.includes(v);
    if (t.versionBelow) return cmpVersion(v, t.versionBelow) < 0;
    return false;
  }

  if (kind === 'plan') {
    const p = String(ctx.plan || '').trim().toLowerCase();
    if (!p) return false;
    return Array.isArray(t.plans) && t.plans.includes(p);
  }
  return false;
}

/** 여러 개가 걸리면 하나를 고른다: 긴급이 먼저, 그 다음 «최근에 시작한» 것. */
function pickOne(list) {
  const sorted = list.slice().sort((a, b) => {
    const la = a.level === 'urgent' ? 0 : 1;
    const lb = b.level === 'urgent' ? 0 : 1;
    if (la !== lb) return la - lb;
    return new Date(b.startAt).getTime() - new Date(a.startAt).getTime();
  });
  return sorted[0] || null;
}

/** 클라이언트에 내보낼 모양. ⛔createdBy(운영자 이메일)·ipHash 같은 내부 값은 절대 싣지 않는다. */
function publicShape(n) {
  if (!n) return null;
  return {
    id: String(n._id),
    title: n.title,
    body: n.body,
    level: n.level,
    startAt: n.startAt,
    endAt: n.endAt,
  };
}

/** 작성 입력 검증. { doc } 또는 { error, message }. */
function validateCreate(body, now) {
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const text = typeof body.body === 'string' ? body.body.trim() : '';
  if (!title) return { error: 'empty_title', message: '제목을 입력하세요.' };
  if (title.length > MAX_TITLE) return { error: 'title_too_long', message: `제목은 ${MAX_TITLE}자 이내여야 합니다.` };
  if (!text) return { error: 'empty_body', message: '본문을 입력하세요.' };
  if (text.length > MAX_BODY) return { error: 'body_too_long', message: `본문은 ${MAX_BODY}자 이내여야 합니다.` };

  const level = LEVELS.includes(String(body.level || '').toLowerCase())
    ? String(body.level).toLowerCase() : 'normal';

  const tgt = normalizeTarget(body.target);
  if (tgt.error) return tgt;

  const startAt = body.startAt ? new Date(body.startAt) : new Date(now);
  if (Number.isNaN(startAt.getTime())) return { error: 'bad_start', message: '시작 시각이 올바르지 않습니다.' };
  if (!body.endAt) return { error: 'missing_end', message: '종료 시각을 정하세요. 기간 없는 공지는 만들 수 없습니다.' };
  const endAt = new Date(body.endAt);
  if (Number.isNaN(endAt.getTime())) return { error: 'bad_end', message: '종료 시각이 올바르지 않습니다.' };
  if (endAt.getTime() <= startAt.getTime()) {
    return { error: 'bad_period', message: '종료 시각이 시작 시각보다 뒤여야 합니다.' };
  }
  if (endAt.getTime() - startAt.getTime() > MAX_PERIOD_MS) {
    return { error: 'period_too_long', message: '공지 기간은 최대 1년입니다.' };
  }
  if (endAt.getTime() <= now) {
    // ★이미 끝난 공지를 «만들 수» 있으면 아무도 못 보는 공지가 조용히 생긴다.
    return { error: 'already_ended', message: '이미 지난 기간입니다. 종료 시각을 앞으로 잡아 주세요.' };
  }

  return { doc: { title, body: text, level, target: tgt.target, startAt, endAt } };
}

module.exports = {
  LEVELS, TARGET_KINDS, MAX_TITLE, MAX_BODY, MAX_PERIOD_MS,
  cmpVersion, normalizeTarget, matchesTarget, pickOne, publicShape, validateCreate,
};
