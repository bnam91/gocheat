/* 세션(로그인 토큰) — «제품별로» 따로 산다.
 *
 * ★왜 고쳤나 (2026-08-25, 현빈 지시)
 *   전엔 users 문서에 sessionToken 이 «한 칸»뿐이었다. 그래서 같은 계정으로
 *   ①홈페이지 로그인 ②고디터 앱 로그인 ③고디브 확장 로그인 중 «나중 것»이 앞의 것을 덮어썼다.
 *   실제 증상 = 이용권 사러 홈페이지에 로그인하면 크롬 확장이 «로그인이 만료되었습니다»로 튕긴다.
 *   시간이 지나서가 아니라 «자기 계정을 다른 데서 한 번 더 써서» 로그아웃되는 것 — 사용자는 이유를 모른다.
 *
 *   ⇒ 토큰을 제품(app)별 칸에 넣는다. 확장의 칸과 홈페이지의 칸은 서로를 밀어내지 않는다.
 *
 * ★2026-08-25 2차 수정 (코덱스 검수 지적 반영) — 이 두 개가 1차에 빠져 있었다.
 *   ①**백필** : 이미 로그인해 둔 사람의 토큰은 «구식 한 칸»에만 있다. 그 사람이 홈페이지에 로그인하면
 *     새 토큰이 그 칸을 덮어써서 «확장이 한 번은 여전히 튕긴다». 고친 줄 알았던 증상이 1회 남는 것이다.
 *     ⇒ 발급 «전에» 구식 토큰을 legacy 칸으로 «옮겨 담는다». 그러면 튕김이 0회가 된다.
 *   ②**원자성** : 전엔 $pull → $push 두 번에 나눠 쳤다. 같은 앱에서 로그인이 «동시에» 두 건 들어오면
 *     둘 다 pull 하고 둘 다 push 해서 앱당 1개 약속이 깨진다(계정 공유 억제가 목적인 규칙이라 구멍이면 안 된다).
 *     ⇒ «집계 파이프라인 업데이트»로 한 번에 친다. 백필·교체·구버전 칸 갱신이 «한 문서 갱신» 안에서 끝난다.
 *     ⚠️파이프라인 업데이트는 MongoDB 4.2+ 가 필요하다(Atlas 는 충족). 그 아래 서버로 내려가면 여기가 깨진다.
 *
 * 저장 모양
 *   users.sessions = [ { app, token, issuedAt, backfilled? } ]   ← 앱당 MAX_PER_APP개
 *   users.sessionToken = '가장 최근 토큰'                          ← ★구버전 호환용으로 «남긴다»
 *
 * ★구버전 호환이 이 파일의 핵심이다.
 *   · 이미 로그인해 둔 사람들은 sessions 배열이 «없다» — sessionToken 만 있다. 그들도 통과해야 한다.
 *   · app 을 안 보내는 옛 클라이언트(고디터 데스크톱 앱)는 'legacy' 칸을 함께 쓴다.
 *     즉 옛 클라이언트끼리는 «지금과 똑같이» 서로를 밀어낸다 — 나빠지지 않는다.
 *     새로 app 을 붙이는 쪽(고디브='godiv', 홈페이지='web')부터 자기 칸을 갖는다.
 *
 * ⛔이 파일에 «조회하면서 쓰는» 함수를 만들지 마라. session.js 주석의 이유 그대로다
 *   (확인하는 일과 세는 일은 분리한다). 여기서 쓰는 건 login 뿐이다.
 */
const { randomToken } = require('./crypto');

// 앱당 몇 개까지 살려둘까. 1 = 지금과 같은 엄격함(한 앱은 한 곳에서만 로그인).
// ★계정 공유 억제와 직결되는 값이라 «정책»이다 — 늘리려면 현빈 승인.
const MAX_PER_APP = 1;
// 문서가 무한히 자라지 않게 하는 안전망(앱 종류가 늘어도 여기서 잘린다).
const MAX_TOTAL = 12;

const DEFAULT_APP = 'legacy';

/** 클라이언트가 보낸 app 문자열을 «칸 이름»으로 정규화한다. 모르는 값은 legacy 칸으로. */
function normalizeApp(value) {
  const s = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return /^[a-z0-9_-]{1,20}$/.test(s) ? s : DEFAULT_APP;
}

/** 토큰 → user. ★조회만 한다.
 *  구식(sessionToken 한 칸)과 신식(sessions 배열)을 «둘 다» 본다 — 둘 다 인덱스가 있다.
 *  「없음」과 「불일치」는 호출부가 같은 응답으로 처리한다(존재를 알아내지 못하게). */
async function findUserBySession(db, sessionToken) {
  const token = typeof sessionToken === 'string' ? sessionToken.trim() : '';
  if (!token) return null;
  return db.collection('users').findOne({
    $or: [{ sessionToken: token }, { 'sessions.token': token }],
  });
}

/**
 * 로그인 성공 시 발급할 «업데이트 파이프라인»을 만든다. (테스트에서 그대로 검사할 수 있게 분리)
 *
 * 세 단계다 — 순서가 곧 의미다.
 *   ①백필 : 구식 sessionToken 이 배열에 «없으면» legacy 칸으로 편입한다.
 *           ⛔③보다 «먼저» 와야 한다. ③이 sessionToken 을 새 값으로 덮어쓰기 때문이다.
 *   ②교체 : 이 앱의 옛 칸을 걷어내고 새 토큰을 넣는다. 다른 앱 칸은 건드리지 않는다. 전체 상한도 여기서.
 *   ③호환 : 옛 코드가 보는 sessionToken/sessionIssuedAt/lastLoginAt 갱신.
 */
function buildIssuePipeline(app, token, issuedAt) {
  const entry = { $literal: { app, token, issuedAt } };
  // 같은 앱에서 «몇 개를 남길지». MAX_PER_APP=1 이면 옛 것은 전부 걷어낸다.
  // ⚠️$slice 는 n=0 을 싫어한다 — 1 이하일 땐 아예 빈 배열 리터럴을 쓴다.
  const keepSameApp = MAX_PER_APP > 1
    ? { $slice: [{ $filter: { input: '$sessions', cond: { $eq: ['$$this.app', app] } } }, -(MAX_PER_APP - 1)] }
    : { $literal: [] };

  return [
    // ① 백필
    // ⚠️★알아두고 «고치지 마라» (2026-08-25 실측): sessions[] 에 이미 legacy 칸이 있는데
    //   구식 sessionToken 이 «그와 다른 값»이면, 백필 직후 legacy 칸이 «2개»가 된다.
    //   · 지금 코드 경로로는 만들어지지 않는 상태다(issueSession 이 둘을 항상 같은 값으로 맞춘다).
    //   · 그래도 그 상태가 되면 «둘 다 살린다» — 어느 쪽이 지금 쓰이는 열쇠인지 서버는 모르기 때문이다.
    //     하나를 골라 버리면 그 사람은 이유 없이 로그아웃된다. ★튕기지 않는 쪽으로 기운다.
    //   · 다음 legacy 로그인에서 ②가 «둘 다» 걷어내고 하나로 정리한다(실측 확인).
    //   ⇒ 「앱당 1개」는 «발급»의 불변식이지 «백필 순간»의 불변식이 아니다. 여기서 dedup 하지 마라.
    {
      $set: {
        sessions: {
          $cond: [
            {
              $and: [
                { $eq: [{ $type: '$sessionToken' }, 'string'] },
                { $ne: ['$sessionToken', ''] },
                { $not: [{ $in: ['$sessionToken', { $map: { input: { $ifNull: ['$sessions', []] }, in: '$$this.token' } }] }] },
              ],
            },
            {
              $concatArrays: [
                { $ifNull: ['$sessions', []] },
                [{
                  app: DEFAULT_APP,
                  token: '$sessionToken',
                  // 언제 발급됐는지 모르면 지금으로 둔다 — «모르는 시각»보다 «늦게 잡힌 시각»이 안전하다.
                  issuedAt: { $ifNull: ['$sessionIssuedAt', issuedAt] },
                  backfilled: true,   // 운영용 표식 — 이 칸이 «옮겨 담긴» 것임을 남긴다
                }],
              ],
            },
            { $ifNull: ['$sessions', []] },
          ],
        },
      },
    },
    // ② 이 앱 칸 교체 + 전체 상한
    {
      $set: {
        sessions: {
          $slice: [
            {
              $concatArrays: [
                { $filter: { input: '$sessions', cond: { $ne: ['$$this.app', app] } } },
                keepSameApp,
                [entry],
              ],
            },
            -MAX_TOTAL,
          ],
        },
      },
    },
    // ③ 구버전 호환 칸
    { $set: { sessionToken: token, sessionIssuedAt: issuedAt, lastLoginAt: issuedAt } },
  ];
}

/** 로그인 성공 시 호출 — 새 토큰을 발급하고 그 앱의 칸에 넣는다. 다른 앱 칸은 건드리지 않는다.
 *  @returns {Promise<{ sessionToken: string, app: string, issuedAt: Date }>} */
async function issueSession(db, email, appRaw) {
  const app = normalizeApp(appRaw);
  const token = randomToken(32);
  const issuedAt = new Date();
  // ★한 번의 updateOne = 원자적. 중간 상태가 «없다» — 동시 로그인 두 건이 겹쳐도 앱당 1개가 유지된다.
  await db.collection('users').updateOne({ email }, buildIssuePipeline(app, token, issuedAt));
  return { sessionToken: token, app, issuedAt };
}

/** 이 유저 문서에서 토큰이 어느 앱 칸에 들었는지 — 없으면 null(구식 sessionToken 이거나 이미 교체됨). */
function appOfToken(user, sessionToken) {
  const list = (user && Array.isArray(user.sessions)) ? user.sessions : [];
  const hit = list.find((s) => s && s.token === sessionToken);
  return hit ? hit.app : null;
}

module.exports = {
  findUserBySession, issueSession, buildIssuePipeline, normalizeApp, appOfToken,
  MAX_PER_APP, MAX_TOTAL, DEFAULT_APP,
};
