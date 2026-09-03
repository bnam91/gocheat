const { getDb } = require('../_lib/mongo');
const { json, handlePreflight, readJsonBody, isValidEmail, normalizeEmail } = require('../_lib/util');

// ★2026-08-18 도메인 통일(현빈 승인): 라이브 = blacksheepwall.kr(EC2). 옛 vercel.app 은 개발용으로 내려간다.
//   ⇒ env PURCHASE_URL 이 없을 때 사용자를 «개발용 사이트»로 보내지 않도록 기본값을 옮긴다.
const PURCHASE_URL = process.env.PURCHASE_URL || 'https://blacksheepwall.kr/pricing.html';

// ★다운로드 주소는 data/downloads.json «한 벌»뿐이다.
//   전에는 이 파일 안에 박혀 있었고, 화면은 그걸 API 로 «받아다» 썼다.
//   2026-08-07 부터 화면이 <a href> 로 직접 간다 — 그래서 두 곳이 같은 파일을 봐야 한다.
//   두 벌로 갈라두면 한쪽만 고치는 사고가 난다(오늘 릴리스 게이트에서 막으려던 그 병이다).
//   ★env 는 «덮어쓰기»로 남긴다 — 드라이브→S3 이전 때 배포만으로 바꿀 길을 잃지 않는다.
//
// ★플랫폼별로 «다른 파일»을 준다. 버튼이 "macOS 버전"이라고 말했는데
//   세 폴더가 든 상위 주소로 보내면 말과 화면이 어긋난다.
const DOWNLOAD_FILE = require('../../data/downloads.json');

const FALLBACK = process.env.DOWNLOAD_URL_GODITOR || DOWNLOAD_FILE.goditor[''];

const DOWNLOAD_URLS = {
  goditor: {
    'mac-arm64': process.env.DOWNLOAD_URL_GODITOR_MAC_ARM64 || DOWNLOAD_FILE.goditor['mac-arm64'],
    'mac-intel': process.env.DOWNLOAD_URL_GODITOR_MAC_INTEL || DOWNLOAD_FILE.goditor['mac-intel'],
    'win': process.env.DOWNLOAD_URL_GODITOR_WIN || DOWNLOAD_FILE.goditor['win'],
    '': FALLBACK,          // 모르는 OS → 전부 보이는 상위 폴더
  },
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
  const url = table[platform] || FALLBACK;

  const hasCreds = isValidEmail(email) && !!sessionToken;

  try {
    const db = await getDb();
    const users = db.collection('users');
    const user = hasCreds ? await users.findOne({ email }) : null;
    // ★★2026-09-03 교정 — 세션 모델이 «둘»이다. 구식 한 칸(sessionToken)만 보면 안 된다.
    //   제품별 칸(sessions[])이 살아난 뒤로, 「고디터로 로그인 → 웹으로도 로그인」 하면
    //   구식 칸은 «웹» 토큰으로 덮이고 고디터 토큰은 sessions[] 에만 남는다.
    //   그 상태에서 고디터 앱이 다운로드를 부르면 authed 가 false 가 되어
    //   ★다운로드가 «익명»으로 처리된다 — 기록(users.downloads)이 안 쌓인다.
    //   ⛔그런데 REQUIRE_LOGIN 이 꺼져 있어 응답은 여전히 ok:true 다. 즉 «조용히» 틀린다.
    //     실측으로만 잡힌다(count 가 안 오르는 것으로 확인했다).
    //   ⇒ session.js·change-password.js 와 «같은 질의»를 쓴다. 한 곳만 고치면 또 어긋난다.
    const authed = !!(user && sessionToken && (
      user.sessionToken === sessionToken ||
      (Array.isArray(user.sessions) && user.sessions.some((x) => x && x.token === sessionToken))
    ));

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
          // ⛔여기서 apps.<id> 번들을 만들지 «않는다»(2026-09-02 되돌림).
          //   ★다운로드는 «로그인 없이도» 된다(DOWNLOAD_REQUIRE_LOGIN=off, 실측 recorded:false).
          //     그러니 「받은 앱」은 대부분 누구 것인지 모르고, 알 수 있는 소수만 잡히면
          //     「이용 중인 앱」이 «반쪽짜리»가 된다 — 반쪽 목록은 없는 것보다 나쁘다.
          //   ★그리고 등록 시점이 둘(다운로드·로그인)이면 firstSeenAt 이 무엇을 뜻하는지 흐려진다.
          //   ⇒ 등록은 «앱에서 로그인하는 순간» 하나로 둔다(현빈 2026-09-02).
          //     downloads.<id> 기록은 그대로 남는다 — 그건 「받았다」는 사실이지 「쓴다」가 아니다.
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
