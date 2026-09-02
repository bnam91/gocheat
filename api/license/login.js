/* ⛔★이 파일은 «라이브보다 뒤처져 있다» (2026-09-02 실측)
 *   라이브(EC2)의 login.js/session.js 는 2026-08-25 에 두 가지가 더 들어갔다:
 *     ① 제품별 세션 칸 (_lib/sessions.js — issueSession / findUserBySession)
 *     ② 앱별 자격     (_lib/entitlements.js — effectiveFor / entitlementsForResponse)
 *   그 두 파일은 «라이브에만» 있고 이 레포엔 없다. 그래서 이 파일을 라이브에 올리면
 *   ①②가 통째로 회귀한다 — 홈페이지 로그인이 크롬 확장을 튕기던 그 증상이 되돌아온다.
 *
 *   ⇒ ⛔배포하려면 이 파일이 아니라 «라이브본에 role 만 더한 패치»를 써라:
 *      지디 스킬 handoff/unitA-server-0.8.6/patches/{login,session}.js
 *   아래 role 줄은 «레포와 라이브의 계약을 같게» 두려고 넣은 것이다(문서·grep 일치용).
 */
const bcrypt = require('bcryptjs');
const { randomToken } = require('../_lib/crypto');
const tiers = require('../_lib/tiers');
const { getDb } = require('../_lib/mongo');
const { json, handlePreflight, readJsonBody, isValidEmail, normalizeEmail } = require('../_lib/util');
const { roleForResponse } = require('../_lib/roles');

// ★2026-08-18 도메인 통일(현빈 승인): 라이브 = blacksheepwall.kr(EC2). 옛 vercel.app 은 개발용으로 내려간다.
//   ⇒ env PURCHASE_URL 이 없을 때 사용자를 «개발용 사이트»로 보내지 않도록 기본값을 옮긴다.
const PURCHASE_URL = process.env.PURCHASE_URL || 'https://blacksheepwall.kr/pricing.html';

// 앱(고디터)이 부르는 유일한 인증 엔드포인트. 라이선스 키를 대체한다.
module.exports = async (req, res) => {
  if (handlePreflight(req, res, { origin: '*' })) return;
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });

  let body;
  try { body = await readJsonBody(req); }
  catch (err) { return json(res, 400, { error: 'invalid_body', detail: err.message }); }

  const email = normalizeEmail(body.email);
  const password = body.password;
  // ★password 는 «문자열»만 받는다. 객체({$ne:...} 등)가 그대로 bcrypt.compare 로 넘어가면
  //   존재하는 계정에서만 던져 500 이 나고, 없는 계정은 401 이라 「가입 여부」가 새어 나갔다.
  //   여기서 문자열이 아니면 DB 조회 «전»에 401 로 끊어, 있는 계정·없는 계정이 «같은» 응답을 낸다.
  //   (email 은 normalizeEmail→isValidEmail 이 이미 문자열로 강제하므로 안전)
  if (!isValidEmail(email) || typeof password !== 'string' || !password) {
    return json(res, 401, { ok: false, reason: 'invalid_credentials' });
  }

  try {
    const db = await getDb();
    const user = await db.collection('users').findOne({ email });
    if (!user) return json(res, 401, { ok: false, reason: 'invalid_credentials' });
    if (!(await bcrypt.compare(password, user.passwordHash || ''))) {
      return json(res, 401, { ok: false, reason: 'invalid_credentials' });
    }
    if (!user.verified) return json(res, 403, { ok: false, reason: 'email_not_verified' });

    const until = user.accessUntil ? new Date(user.accessUntil) : null;
    const expired = until ? until.getTime() < Date.now() : false;
    // ★앱이 비밀번호를 저장하면 안 된다 — 토큰만 주고 앱은 그것만 보관한다
    const sessionToken = randomToken(32);
    const now = new Date();
    const set = { lastLoginAt: now, sessionToken, sessionIssuedAt: now };

    // ★★앱별 «번들»(현빈 2026-09-02: 「앱별로 로그인을 하면 앱별로 키밸류 번들이 추가된다」).
    //   users.apps.<앱id> 에 그 앱의 이용 기록이 쌓인다. 계정 하나에 앱이 여러 개 붙는 구조다.
    //   ★download.js 가 이미 users.downloads.<앱id> 를 같은 꼴로 쓰고 있다 — 그 관례를 따른다.
    //   ⛔plan 응답은 «그대로» 둔다. 데스크톱 앱이 그 값을 읽는다 — 모양을 바꾸면 앱이 깨진다.
    //     앱별 등급은 apps.<id>.plan 에 «추가»로 들어가고, 없으면 계정 등급에서 파생한다.
    //   ⚠️앱이 app 을 «안 보내면» 번들이 안 생긴다. 웹사이트 로그인은 앱이 아니므로 그게 맞다.
    //     데스크톱 앱·확장이 번들을 가지려면 로그인 요청에 app 을 실어야 한다(앱 쪽 작업).
    const appId = typeof body.app === 'string' ? body.app.trim().toLowerCase() : '';
    if (/^[a-z][a-z0-9-]{0,31}$/.test(appId) && tiers.appMeta(appId)) {
      const k = 'apps.' + appId;
      const meta = tiers.appMeta(appId);
      set[k + '.lastLoginAt'] = now;
      // 유형·이름은 «표»에서 온다 — 번들에 박아 두면 나중에 이름을 바꿔도 옛 값이 남는다.
      set[k + '.kind'] = meta.kind;
      set[k + '.name'] = meta.name;
      // ★첫 접촉 시각과 «기본 등급»은 덮어쓰지 않는다.
      //   $min 은 없으면 넣고 있으면 더 이른 값을 남긴다 — $setOnInsert 는 «문서» 삽입에만
      //   걸려서 중첩 필드엔 못 쓴다. 등급도 같은 이유로 $min 을 쓰면 «이미 올린 등급»을
      //   기본값으로 끌어내리지 않는다(기본 1 < 올린 값이므로 $min 은 위험하다) ⇒ 등급은 «없을 때만» 넣는다.
      await db.collection('users').updateOne(
        { email }, { $min: { [k + '.firstSeenAt']: now } });
      await db.collection('users').updateOne(
        { email, [k + '.tier']: { $exists: false } },
        { $set: { [k + '.tier']: tiers.DEFAULT_TIER, [k + '.payment']: null } });
    }

    await db.collection('users').updateOne({ email }, { $set: set });

    return json(res, 200, {
      ok: !expired,
      email,
      plan: user.plan || 'event_free',
      sessionToken,
      accessUntil: until,
      // ★2026-09-02 additive: 계정 역할. 앱이 «공지 작성 탭을 보여줄까»를 정하는 데만 쓴다.
      //   ⛔이 값은 «권한이 아니다». 권한은 서버가 POST /api/notice 에서 DB 의 role 로 다시 판정한다
      //     (_lib/roles.js). 앱이 이걸 위조해도 발송은 서버에서 막힌다.
      //   ★null 을 «항상» 싣는다 — 필드가 없으면 「구버전 서버」, null 이면 「일반 사용자」로 갈린다.
      role: roleForResponse(user),
      // ★막기만 하고 어디로 가라고 안 하면 사용자는 또 헤맨다 — 갈 곳을 함께 준다
      ...(expired ? { reason: 'expired', purchaseUrl: PURCHASE_URL } : {}),
    });
  } catch (err) {
    console.error('[login] error', err);
    return json(res, 500, { ok: false, reason: 'internal_error' });
  }
};
