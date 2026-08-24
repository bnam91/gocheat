const { getDb } = require('../_lib/mongo');
const { findUserBySession, appOfToken } = require('../_lib/sessions');
const { json, handlePreflight, readJsonBody, isValidEmail, normalizeEmail } = require('../_lib/util');

// ★2026-08-18 도메인 통일(현빈 승인): 라이브 = blacksheepwall.kr(EC2). 옛 vercel.app 은 개발용으로 내려간다.
//   ⇒ env PURCHASE_URL 이 없을 때 사용자를 «개발용 사이트»로 보내지 않도록 기본값을 옮긴다.
const PURCHASE_URL = process.env.PURCHASE_URL || 'https://blacksheepwall.kr/pricing.html';

/* 세션 재검증 — ★«조회 전용»이다. 아무것도 쓰지 않는다.
 *
 * ★왜 새로 만들었나 (2026-08-13)
 *   앱은 로그인 후 sessionToken 만 보관한다(비밀번호는 저장하지 않는다). 그런데 그 토큰이
 *   «아직 유효한가»를 물을 곳이 없었다. 유일한 대조처가 download.js 였는데 그건 다운로드
 *   카운터를 «증가»시킨다 — 하트비트로 쓰면 받지도 않은 다운로드가 쌓여 «사용자를 센다»는
 *   목적 자체가 망가진다. 그래서 앱은 재검증을 no-op 으로 뒀고, 결과적으로 한 번 로그인한
 *   사람이 «무기한» 열려 있었다.
 *   ⇒ 부작용 없는 조회구를 따로 낸다. 세는 일(download)과 확인하는 일(session)을 분리한다.
 *
 * ⛔이 파일에 «쓰기»를 추가하지 마라. lastSeenAt 하나만 찍어도 이 엔드포인트는 하트비트가
 *   아니라 계측기가 되고, 그때부터 앱은 이걸 마음 편히 주기적으로 부를 수 없다.
 *   기록이 필요하면 «다른» 엔드포인트를 만들어라.
 *
 * 입력  { sessionToken, email? }   — email 은 있으면 «추가로» 대조한다(없어도 된다)
 * 출력  { ok, email, plan, accessUntil, sessionIssuedAt }
 */
module.exports = async (req, res) => {
  if (handlePreflight(req, res, { origin: '*' })) return;
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });

  let body;
  try { body = await readJsonBody(req); }
  catch (err) { return json(res, 400, { error: 'invalid_body', detail: err.message }); }

  const sessionToken = typeof body.sessionToken === 'string' ? body.sessionToken.trim() : '';
  if (!sessionToken) return json(res, 401, { ok: false, reason: 'invalid_session' });

  try {
    const db = await getDb();
    // ★토큰만으로 찾는다 — 앱이 이메일을 잃어도 재검증은 돌아야 한다(토큰은 32바이트 난수다).
    // ★2026-08-25: 제품별 칸(sessions[])과 구식 한 칸(sessionToken)을 «둘 다» 본다.
    //   이미 로그인해 둔 사람들은 배열이 없다 — 그들을 여기서 튕기면 «업데이트가 곧 전원 로그아웃»이 된다.
    const user = await findUserBySession(db, sessionToken);
    // ★「없음」과 「불일치」를 같은 응답으로 돌려준다 — 토큰을 넣어보고 존재를 알아내지 못하게.
    if (!user) return json(res, 401, { ok: false, reason: 'invalid_session' });

    // email 을 함께 보냈으면 대조한다. 토큰이 맞아도 짝이 안 맞으면 거절한다.
    if (body.email !== undefined) {
      const claimed = normalizeEmail(body.email);
      if (!isValidEmail(claimed) || claimed !== user.email) {
        return json(res, 401, { ok: false, reason: 'invalid_session' });
      }
    }

    if (!user.verified) return json(res, 403, { ok: false, reason: 'email_not_verified' });

    // 만료 판정은 login.js 와 «같은 규칙»이다 — 두 곳이 다르게 굴면 앱이 오락가락한다.
    const until = user.accessUntil ? new Date(user.accessUntil) : null;
    const expired = until ? until.getTime() < Date.now() : false;

    return json(res, 200, {
      ok: !expired,
      email: user.email,
      plan: user.plan || 'event_free',
      accessUntil: until,
      // ★앱이 «세션 자체의 나이»로 판단할 수 있게 같이 준다(서버는 세션 TTL 정책을 갖고 있지 않다).
      sessionIssuedAt: user.sessionIssuedAt || null,
      // 이 토큰이 들어 있는 제품 칸(구식 토큰이면 null). 진단용 — 클라이언트 판정에 쓰지 않는다.
      app: appOfToken(user, sessionToken),
      ...(expired ? { reason: 'expired', purchaseUrl: PURCHASE_URL } : {}),
    });
  } catch (err) {
    console.error('[session] error', err);
    return json(res, 500, { ok: false, reason: 'internal_error' });
  }
};
