const { getDb } = require('../_lib/mongo');
const { json, handlePreflight, readJsonBody, isValidEmail, normalizeEmail } = require('../_lib/util');

const PURCHASE_URL = process.env.PURCHASE_URL || 'https://hompageapp.vercel.app/pricing.html';

// ★다운로드 주소는 data/downloads.json «한 벌»뿐이다.
//   전에는 이 파일 안에 박혀 있었고, 화면은 그걸 API 로 «받아다» 썼다.
//   2026-08-07 부터 화면이 <a href> 로 직접 간다 — 그래서 두 곳이 같은 파일을 봐야 한다.
//   두 벌로 갈라두면 한쪽만 고치는 사고가 난다(오늘 릴리스 게이트에서 막으려던 그 병이다).
//   ★env 는 «덮어쓰기»로 남긴다 — 드라이브→S3 이전 때 배포만으로 바꿀 길을 잃지 않는다.
//
// ★플랫폼별로 «다른 파일»을 준다. 버튼이 "macOS 버전"이라고 말했는데
//   세 폴더가 든 상위 주소로 보내면 말과 화면이 어긋난다.
const DOWNLOAD_FILE = require('../../data/downloads.json');

// ★슬롯이 없어도 «죽지 않게» 읽는다. 전에는 DOWNLOAD_FILE.goditor[''] 를 직접 읽었는데,
//   그 키가 없는 downloads.json 이 배포되면 require 시점에 TypeError 가 나고
//   ★goditor 다운로드까지 통째로 500 이 된다(앱을 하나 더 얹으면서 밟기 딱 좋은 자리다).
const slot = (app) => DOWNLOAD_FILE[app] || {};

// ★env 이름은 앱마다 갈린다: DOWNLOAD_URL_<APP>_<PLATFORM>.
const envUrl = (app, key) => process.env['DOWNLOAD_URL_' + app.toUpperCase() + (key ? '_' + key : '')];

// ★«앱별» 상위 폴더다. 예전엔 goditor 상위 폴더 하나를 전역 FALLBACK 으로 썼는데,
//   앱이 둘이 되는 순간 그건 «godiv 받으러 온 사람을 goditor 폴더로 보내는» 코드가 된다.
const appTable = (app) => ({
  'mac-arm64': envUrl(app, 'MAC_ARM64') || slot(app)['mac-arm64'],
  'mac-intel': envUrl(app, 'MAC_INTEL') || slot(app)['mac-intel'],
  'win': envUrl(app, 'WIN') || slot(app)['win'],
  '': envUrl(app, '') || slot(app)[''],   // 모르는 OS → 전부 보이는 상위 폴더
});

const DOWNLOAD_URLS = {
  goditor: appTable('goditor'),
  // ★godiv 는 아직 «주소가 빈 값»이다(빌드 전). 그래도 여기 등록해 둔다 —
  //   등록이 없으면 unknown_app 이라 화면이 눌러도 «기록이 0건»으로 조용히 샌다.
  //   주소가 비면 아래에서 url:'' 로 나가고, 화면은 애초에 버튼을 켜지 않는다.
  godiv: appTable('godiv'),
};

// ★이벤트 종료 후 다시 «회원만» 으로 돌릴 수 있게 조건만 남겨둔다.
//   로직을 지우면 그때 다시 만들어야 한다 — 끄고 켜는 형태로 둔다.
const REQUIRE_LOGIN = process.env.DOWNLOAD_REQUIRE_LOGIN === 'on';

// 다운로드 주소를 내려주고, 로그인 상태면 «받아간 기록»을 남기는 엔드포인트.
//
// ★게이트가 아니라 «선택적 기록»이다 (2026-08-07 방향 전환).
//   비회원도 그냥 받는다. 로그인해서 온 사람만 기록이 남는다.
//   원래도 드라이브 폴더가 링크 공개라 차단이 아니었고, 실제 사용 통제는
//   앱의 로그인(accessUntil)이 한다 — 화면과 실제 구조를 일치시킨 것이다.
//   ⚠️ 대신 «누가 받았나» 데이터는 회원분만 남는다.
//
// ★익명으로는 «기록»할 수 없다. sessionToken 을 대조하지 않으면 카운트가 오염된다.
//   (익명은 통과시키되 세지 않는다 — 통과와 기록은 다른 문제다)
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

  const table = DOWNLOAD_URLS[app];
  if (!table) return json(res, 200, { ok: false, reason: 'unknown_app' });

  // ★플랫폼은 «서버가» 최종 판단한다. 클라이언트 문자열을 그대로 믿되
  //   화이트리스트에 없으면 상위 폴더로 — 모르는 값이 링크를 깨뜨리지 않게.
  const asked = typeof body.platform === 'string' ? body.platform.trim().toLowerCase() : '';
  const platform = Object.prototype.hasOwnProperty.call(table, asked) && asked ? asked : '';
  // ★폴백은 «그 앱의» 상위 폴더다. 전역 폴백을 쓰면 godiv 요청이 goditor 폴더로 간다.
  //   아직 주소가 없는 앱이면 '' 로 나간다 — 화면은 그 값으로 버튼을 켜지 않는다.
  const url = table[platform] || table[''] || '';

  // ★주소가 «아직 없는» 앱(등록만 해둔 자리)은 여기서 끝낸다.
  //   ok:true + 빈 주소로 답하면 「받았다」는 뜻이 되고, 그 아래에서 «받지도 않은 다운로드»가
  //   카운트로 쌓인다. 세는 것과 통과시키는 건 다른 문제다 — 셀 일이 없으면 세지 않는다.
  if (!url) return json(res, 200, { ok: false, reason: 'not_released', app });

  const hasCreds = isValidEmail(email) && !!sessionToken;

  try {
    const db = await getDb();
    const users = db.collection('users');
    const user = hasCreds ? await users.findOne({ email }) : null;
    const authed = !!(user && user.sessionToken && user.sessionToken === sessionToken);

    // 이벤트 종료 후 다시 회원 전용으로 돌릴 자리 (기본은 꺼져 있다)
    if (REQUIRE_LOGIN && !authed) {
      return json(res, 200, { ok: false, reason: 'login_required' });
    }

    if (authed) {
      const until = user.accessUntil ? new Date(user.accessUntil) : null;
      const expired = until ? until.getTime() < Date.now() : false;
      const plan = user.plan || 'event_free';

      if (REQUIRE_LOGIN && expired) {
        // 막기만 하고 어디로 가라고 안 하면 사용자는 또 헤맨다 — 갈 곳을 함께 준다
        return json(res, 200, {
          ok: false, reason: 'expired', plan, accessUntil: until, purchaseUrl: PURCHASE_URL,
        });
      }

      // 기록. 배열로 쌓지 않는다 — 여러 번 받으면 무한히 자란다.
      // 「누가 받았나」는 { 'downloads.goditor': { $exists: true } } 로 뽑으면 된다.
      const now = new Date();
      await users.updateOne({ email }, {
        $set: {
          ['downloads.' + app + '.lastAt']: now,
          ['downloads.' + app + '.lastPlan']: plan,
          ['downloads.' + app + '.lastPlatform']: platform || 'unknown',
        },
        $inc: { ['downloads.' + app + '.count']: 1 },
      });
      if (!user.downloads || !user.downloads[app] || !user.downloads[app].firstAt) {
        await users.updateOne({ email }, { $set: { ['downloads.' + app + '.firstAt']: now } });
      }
      return json(res, 200, { ok: true, app, platform, url, plan, accessUntil: until, recorded: true });
    }

    // 비회원 — 통과시키되 세지 않는다
    return json(res, 200, { ok: true, app, platform, url, recorded: false });
  } catch (err) {
    console.error('[download] error', err);
    // ★기록이 실패해도 «다운로드는 막지 않는다». 주소는 DB 없이도 안다.
    return json(res, 200, { ok: true, app, platform, url, recorded: false, note: 'record_failed' });
  }
};
