const { getDb } = require('../_lib/mongo');
const { json, handlePreflight, readJsonBody, isValidEmail, normalizeEmail } = require('../_lib/util');

const PURCHASE_URL = process.env.PURCHASE_URL || 'https://hompageapp.vercel.app/pricing.html';

// ★다운로드 주소는 «여기 한 곳»에서만 내려준다.
//   화면에 박아두면 배포처를 바꿀 때 페이지를 다시 고쳐야 한다.
//   드라이브 → S3 로 옮길 때 이 env 하나만 갈아끼우면 끝나게 해 둔다.
const DOWNLOAD_URLS = {
  goditor: process.env.DOWNLOAD_URL_GODITOR
    || 'https://drive.google.com/drive/folders/154OLVED3VKx2BrvYvayNh-SHnQfAuyP0',
};

// 회원이 앱을 «받아간 기록»을 남기는 엔드포인트.
//
// ★이건 «접근 차단»이 아니라 «기록»이다.
//   드라이브 폴더는 링크 공개라, 링크를 아는 사람은 이 흐름과 무관하게 받는다.
//   실제 차단은 앱의 로그인이 한다(accessUntil 이 지나면 편집기 대신 만료 화면).
//   그러니 화면에서도 "권한"인 척하지 않는다 — 여기서 얻는 건
//   ⓐ 회원 중 누가 받았는지 ⓑ 이벤트 종료 후 권한을 다룰 근거, 이 둘이다.
//
// ★익명으로는 기록할 수 없다. sessionToken 을 대조하지 않으면 카운트가 오염된다.
// ★앱의 login 계약은 건드리지 않는다 — 별도 엔드포인트로 얹는다.
module.exports = async (req, res) => {
  if (handlePreflight(req, res, { origin: '*' })) return;
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });

  res.setHeader('Access-Control-Allow-Origin', '*');

  let body;
  try { body = await readJsonBody(req); }
  catch (err) { return json(res, 400, { error: 'invalid_body', detail: err.message }); }

  const email = normalizeEmail(body.email);
  const sessionToken = typeof body.sessionToken === 'string' ? body.sessionToken.trim() : '';
  const app = (typeof body.app === 'string' ? body.app.trim().toLowerCase() : 'goditor') || 'goditor';

  // 거절도 200 + ok:false 로 준다 — session.js 와 같은 축.
  // (비200 은 «판단 불가»의 뜻으로 쓰고 있다)
  if (!isValidEmail(email) || !sessionToken) {
    return json(res, 200, { ok: false, reason: 'invalid_session' });
  }
  if (!DOWNLOAD_URLS[app]) {
    return json(res, 200, { ok: false, reason: 'unknown_app' });
  }

  try {
    const db = await getDb();
    const users = db.collection('users');
    const user = await users.findOne({ email });

    // 계정 없음과 토큰 불일치를 구분해 알려주지 않는다(계정 존재 여부 노출 방지)
    if (!user || !user.sessionToken || user.sessionToken !== sessionToken) {
      return json(res, 200, { ok: false, reason: 'invalid_session' });
    }

    const until = user.accessUntil ? new Date(user.accessUntil) : null;
    const expired = until ? until.getTime() < Date.now() : false;
    const plan = user.plan || 'event_free';

    if (expired) {
      // 막기만 하고 어디로 가라고 안 하면 사용자는 또 헤맨다 — 갈 곳을 함께 준다
      return json(res, 200, {
        ok: false, reason: 'expired', plan, accessUntil: until, purchaseUrl: PURCHASE_URL,
      });
    }

    // 기록. 배열로 쌓지 않는다 — 여러 번 받으면 무한히 자란다.
    // 「누가 받았나」는 { 'downloads.goditor': { $exists: true } } 로 뽑으면 된다.
    const now = new Date();
    await users.updateOne(
      { email },
      {
        $set: { ['downloads.' + app + '.lastAt']: now, ['downloads.' + app + '.lastPlan']: plan },
        $inc: { ['downloads.' + app + '.count']: 1 },
        $setOnInsert: {},
      },
    );
    // 최초 1회만 기록되게 별도 업데이트(위 $set 과 충돌하지 않도록 분리)
    if (!user.downloads || !user.downloads[app] || !user.downloads[app].firstAt) {
      await users.updateOne({ email }, { $set: { ['downloads.' + app + '.firstAt']: now } });
    }

    return json(res, 200, {
      ok: true,
      app,
      url: DOWNLOAD_URLS[app],
      plan,
      accessUntil: until,
    });
  } catch (err) {
    console.error('[download] error', err);
    // 서버 오류는 500 — 화면은 이때 «기록만 실패했다»고 알리고 다운로드 자체는 막지 않는다
    return json(res, 500, { ok: false, reason: 'internal_error' });
  }
};
