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
 * 저장 모양
 *   users.sessions = [ { app: 'godiv', token: '...', issuedAt: Date }, ... ]   ← 앱당 MAX_PER_APP개
 *   users.sessionToken = '가장 최근 토큰'                                       ← ★구버전 호환용으로 «남긴다»
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

/** 로그인 성공 시 호출 — 새 토큰을 발급하고 그 앱의 칸에 넣는다. 다른 앱 칸은 건드리지 않는다.
 *  @returns {Promise<{ sessionToken: string, app: string, issuedAt: Date }>} */
async function issueSession(db, email, appRaw) {
  const app = normalizeApp(appRaw);
  const token = randomToken(32);
  const issuedAt = new Date();
  const users = db.collection('users');

  // ★$pull 과 $push 를 한 번에 못 쓴다(같은 필드) — 두 번 나눠 친다.
  //   ①먼저 이 앱의 옛 칸을 비우고 ②새 걸 넣는다. 사이에 끼어들어도 최악이 «재로그인»이라 안전하다.
  await users.updateOne({ email }, { $pull: { sessions: { app } } });
  await users.updateOne({ email }, {
    $push: {
      sessions: {
        $each: [{ app, token, issuedAt }],
        // 앱당 MAX_PER_APP 는 위 $pull 로 이미 지켜진다. 여기선 «전체» 상한만 본다(오래된 것부터 버림).
        $slice: -MAX_TOTAL,
      },
    },
    // 구버전 호환 — 옛 코드가 이 칸만 보더라도 «가장 최근 로그인»은 여기 있다.
    // ⚠️이 칸이 덮어써져도 앞선 앱의 토큰은 sessions 배열에 살아 있어 findUserBySession 이 찾는다.
    $set: { sessionToken: token, sessionIssuedAt: issuedAt, lastLoginAt: issuedAt },
  });

  return { sessionToken: token, app, issuedAt };
}

/** 이 유저 문서에서 토큰이 어느 앱 칸에 들었는지 — 없으면 null(구식 sessionToken 이거나 이미 교체됨). */
function appOfToken(user, sessionToken) {
  const list = (user && Array.isArray(user.sessions)) ? user.sessions : [];
  const hit = list.find((s) => s && s.token === sessionToken);
  return hit ? hit.app : null;
}

module.exports = { findUserBySession, issueSession, normalizeApp, appOfToken, MAX_PER_APP, MAX_TOTAL, DEFAULT_APP };
