process.env.BETA_UNTIL = '2026-12-31T23:59:59Z';
const { normalizeAppId, resolvePlan, registerApp } = require('./plan');

// ── 가짜 DB: updateOne 이 «필터»를 지키는지까지 흉내낸다 ──
function fakeDb(docs) {
  return { collection: () => ({
    async updateOne(filter, upd) {
      const d = docs.find(x => x.email === filter.email);
      if (!d) return { modifiedCount: 0 };
      const k = Object.keys(filter).find(k => k !== 'email');
      if (k && filter[k].$exists === false) {
        const path = k.split('.');            // apps.goditor
        if (d[path[0]] && d[path[0]][path[1]]) return { modifiedCount: 0 };  // 이미 있다 → 안 건드림
      }
      const [set] = Object.entries(upd.$set);
      const p = set[0].split('.');
      d[p[0]] = d[p[0]] || {}; d[p[0]][p[1]] = set[1];
      return { modifiedCount: 1 };
    },
    async findOne({ email }) { return docs.find(x => x.email === email) || null; },
  })};
}
const D = (s) => new Date(s);
let fail = 0;
const t = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`  ${ok ? '✅' : '❌'} ${name}${ok ? '' : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`}`);
};

// ① 앱 id 검증 — 남이 준 값이다
t("normalizeAppId('goditor')", normalizeAppId('goditor'), 'goditor');
t("normalizeAppId('GODITOR')", normalizeAppId('GODITOR'), 'goditor');
t("normalizeAppId('../evil')", normalizeAppId('../evil'), null);
t("normalizeAppId(undefined)", normalizeAppId(undefined), null);
t("normalizeAppId('goditor.x')", normalizeAppId('goditor.x'), null);

(async () => {
  // ② 새 계정 — 첫 로그인에 등록되고, 두 번째엔 «안 만든다»
  const docs = [{ email: 'a@x.com' }];
  const db = fakeDb(docs);
  t('첫 로그인 → 등록됨', await registerApp(db, 'a@x.com', 'goditor'), true);
  t('  plan 은 free 로 생김', docs[0].apps.goditor.plan, 'free');
  t('둘째 로그인 → 등록 안 함', await registerApp(db, 'a@x.com', 'goditor'), false);

  // ③ ★유료 사용자를 «덮지 않는가» — 제일 위험한 케이스
  const paid = [{ email: 'p@x.com', apps: { goditor: { plan: 'pro', accessUntil: D('2027-02-01') } } }];
  const pdb = fakeDb(paid);
  t('유료 계정 재로그인 → 등록 안 함', await registerApp(pdb, 'p@x.com', 'goditor'), false);
  t('  ★plan 이 pro 로 «유지»', paid[0].apps.goditor.plan, 'pro');

  // ④ 판정
  const u  = { apps: { goditor: { plan: 'free', accessUntil: null } } };
  const up = { apps: { goditor: { plan: 'pro',  accessUntil: D('2027-02-01') } } };
  t('베타 중 · 신규       → beta', resolvePlan(u,  'goditor', D('2026-08-07')).plan, 'beta');
  t('베타 중 · 유료       → beta', resolvePlan(up, 'goditor', D('2026-08-07')).plan, 'beta');
  t('베타 후 · 신규       → free', resolvePlan(u,  'goditor', D('2027-01-01')).plan, 'free');
  t('베타 후 · 유료 유효  → pro ', resolvePlan(up, 'goditor', D('2027-01-01')).plan, 'pro');
  t('베타 후 · 유료 만료  → free', resolvePlan(up, 'goditor', D('2027-06-01')).plan, 'free');
  t('apps 자체가 없음     → free', resolvePlan({}, 'goditor', D('2027-01-01')).plan, 'free');
  t('  등록 여부도 알려준다', resolvePlan({}, 'goditor', D('2027-01-01')).registered, false);
  t('옛 event_free 는 유료 아님', resolvePlan({apps:{goditor:{plan:'event_free',accessUntil:D('2030-01-01')}}}, 'goditor', D('2027-01-01')).plan, 'free');

  console.log(fail ? `\n  ★ 실패 ${fail}건` : '\n  전부 통과');
  process.exit(fail ? 1 : 0);
})();
