/* 계정 «역할(role)» — 공지 발송 같은 위험한 권한의 단일 판정처.
 *
 * ★왜 이 파일이 있나 (2026-09-02, PLAN §2⑷)
 *   전체 사용자에게 모달을 띄우는 능력은 심각한 권한이다. 화면에서 버튼을 감추는 것은
 *   «편의»일 뿐 보안이 아니다 — 누구나 POST 를 직접 칠 수 있다.
 *   ⇒ 권한은 «서버»가 지킨다. 그 판정을 여기 한 곳에 모은다.
 *
 * 저장 모양 (additive — 기존 필드는 건드리지 않는다)
 *   users.role = 'admin'      ← 이 값일 때만 어드민. 없으면(undefined) 일반 사용자.
 *   ⛔기본값을 'user' 로 «채워 넣지» 마라. 없는 것이 곧 일반이다. 마이그레이션이 필요 없다.
 *
 * ★판정은 «DB 의 지금 값»으로 한다.
 *   클라이언트가 보낸 role 은 절대 믿지 않는다. 로그인 응답에 실어 보내는 role 은
 *   «탭을 보여줄까»를 정하는 힌트일 뿐, 권한의 근거가 아니다.
 *   그래서 토큰을 폐기(로그아웃)하면 그 즉시 거부된다(PLAN §9 D-d).
 */

const ADMIN = 'admin';

/** users 문서 → 어드민인가. ⛔여기 외의 곳에서 role 문자열을 직접 비교하지 마라. */
function isAdminUser(user) {
  return String((user && user.role) || '').trim().toLowerCase() === ADMIN;
}

/** 로그인·세션 응답에 실을 값. 어드민이면 'admin', 아니면 null.
 *  ★null 을 «항상» 실어 보낸다(필드를 빼지 않는다) — 그래야 앱이
 *    「role:null = 일반 사용자」와 「필드 없음 = 아직 이 패치가 안 실린 서버」를 구분할 수 있다.
 *    둘 다 탭을 감추는 건 같지만, 원인을 못 가르면 「왜 안 보이지」를 두 번 조사하게 된다. */
function roleForResponse(user) {
  return isAdminUser(user) ? ADMIN : null;
}

/* 토큰 → user.
 * ★_lib/sessions.js 가 있으면 그걸 쓴다(제품별 세션 칸이 그 파일의 소관이라 로직이 두 벌이 되면 안 된다).
 *   ⚠️그 파일은 «라이브에만» 있고 레포엔 없다(2026-09-02 실측). 없을 때는 같은 뜻의 질의로 떨어진다 —
 *   두 인덱스(users.sessionToken, users.sessions.token)가 모두 mongo.js 에 서 있어서 성능도 같다. */
let findUserBySessionImpl = null;
try {
  ({ findUserBySession: findUserBySessionImpl } = require('./sessions'));
} catch (_) { /* 레포 체크아웃에는 없다 — 아래 폴백을 쓴다 */ }

async function findUserBySession(db, sessionToken) {
  const token = typeof sessionToken === 'string' ? sessionToken.trim() : '';
  if (!token) return null;
  if (findUserBySessionImpl) return findUserBySessionImpl(db, token);
  return db.collection('users').findOne({
    $or: [{ sessionToken: token }, { 'sessions.token': token }],
  });
}

/**
 * ★어드민 게이트. 이 함수가 «막았다»의 본체다.
 *
 * 세 갈래를 «다르게» 답한다 — 어드민 도구를 만드는 사람이 원인을 알아야 하기 때문이다.
 *   토큰 없음/폐기 → 401 unauthorized   (로그아웃 후 POST 가 여기로 온다)
 *   토큰은 살았으나 role 이 아님 → 403 forbidden
 *   미인증 계정 → 403
 * ⚠️「없는 계정」과 「틀린 토큰」은 «같은» 401 이다(존재를 알아내지 못하게).
 *
 * @returns {{ ok:true, user }} | {{ ok:false, status, error, message }}
 */
async function requireAdmin(db, sessionToken) {
  const token = typeof sessionToken === 'string' ? sessionToken.trim() : '';
  if (!token) {
    return { ok: false, status: 401, error: 'unauthorized', message: '로그인이 필요합니다.' };
  }
  const user = await findUserBySession(db, token);
  if (!user) {
    return { ok: false, status: 401, error: 'unauthorized', message: '로그인이 만료되었습니다. 다시 로그인해 주세요.' };
  }
  if (!user.verified) {
    return { ok: false, status: 403, error: 'email_not_verified', message: '이메일 인증이 필요합니다.' };
  }
  /* ★«이용기간 만료»는 여기서 보지 않는다 — 의도한 결정이다(2026-09-02, G4 문의로 명문화).
   *   role='admin' 은 «운영자»라는 신분이지 «구매한 이용권»이 아니다. accessUntil 이 지났다고
   *   공지 발송·신고 열람을 못 하게 만들면, 결제 필드 하나가 운영 기능을 끊는다 —
   *   장애 공지를 띄워야 할 바로 그 순간에 못 띄우는 상황이 된다.
   *   ⇒ 만료된 어드민도 통과한다. 화면(Unit D)도 같게 굴어야 한다(서버보다 좁게 막지 마라).
   *   ⛔막고 싶어지면 여기 한 줄이 아니라 «정책»으로 정하고 이 주석을 고쳐라. */
  if (!isAdminUser(user)) {
    // ⛔「어드민이 아니다」를 200 으로 돌려주지 마라. 호출부가 실수로 통과시킬 수 있다.
    // ⛔말은 «일반»으로 둔다 — 이 게이트는 공지 말고도 신고 열람·이미지 열람이 함께 쓴다.
    //   경로별로 다른 말이 필요하면 호출부가 message 를 갈아 끼워라.
    return { ok: false, status: 403, error: 'forbidden', message: '운영자만 사용할 수 있는 기능입니다.' };
  }
  return { ok: true, user };
}

module.exports = { ADMIN, isAdminUser, roleForResponse, findUserBySession, requireAdmin };
