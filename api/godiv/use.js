const { getDb } = require('../_lib/mongo');
const { findUserBySession } = require('../_lib/sessions');
const { json, handlePreflight, readJsonBody, isValidEmail, normalizeEmail } = require('../_lib/util');

/* 고디브(크롬 확장) «사용 기록» — 누가·언제·몇 번·어디서 받았는지 남긴다.
 *
 * ★왜 새 엔드포인트인가 (2026-08-25, 현빈 지시)
 *   지금까지 DB 는 「이 회원이 고디브를 쓴다」를 몰랐다. 확장이 부르는 건 login 과 session 뿐인데
 *   · login  = 제품 구분 없이 lastLoginAt 만 갱신한다(고디터 앱·홈페이지 로그인과 구별이 안 된다)
 *   · session = ⛔«조회 전용»이다. 거기에 기록을 얹으면 확인용 엔드포인트가 계측기가 된다(session.js 주석).
 *   ⇒ 세는 일을 «여기»로 분리한다. 확인(session)과 계측(use)은 끝까지 다른 문 이어야 한다.
 *
 * ★언제 부르나 = «다운로드가 실제로 성공한 직후» 1회.
 *   페이지를 열 때마다 부르면 «열어만 본 사람»까지 세어져 숫자가 오염된다.
 *   열어본 것도 세고 싶어지면 그건 다른 필드다 — count 에 섞지 마라.
 *
 * 입력  { sessionToken, email?, site?, images? }
 * 출력  { ok, recorded, count?, reason? }
 *
 * ★기록 실패가 사용자에게 «보이는 실패»가 되면 안 된다 — 확장은 응답을 무시한다(fire-and-forget).
 *   그래도 서버는 사유를 정확히 돌려준다. 조용한 실패는 만들지 않는다(나중에 로그로 원인을 찾아야 한다).
 */
module.exports = async (req, res) => {
  if (handlePreflight(req, res, { origin: '*' })) return;
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });
  res.setHeader('Access-Control-Allow-Origin', '*');

  let body;
  try { body = await readJsonBody(req); }
  catch (err) { return json(res, 400, { error: 'invalid_body', detail: err.message }); }

  const sessionToken = typeof body.sessionToken === 'string' ? body.sessionToken.trim() : '';
  if (!sessionToken) return json(res, 401, { ok: false, recorded: false, reason: 'invalid_session' });

  // 어느 쇼핑몰에서 썼나. 화이트리스트 밖은 'other' — 클라이언트 문자열이 필드를 오염시키지 못하게.
  const SITES = ['naver', 'coupang', 'wadiz'];
  const asked = typeof body.site === 'string' ? body.site.trim().toLowerCase() : '';
  const site = SITES.includes(asked) ? asked : 'other';
  // 받은 장수 — 숫자만, 상한을 둔다(오타·조작으로 합계가 튀지 않게).
  const n = Number(body.images);
  const images = Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 5000) : 0;

  try {
    const db = await getDb();
    const user = await findUserBySession(db, sessionToken);
    // ★「없음」과 「불일치」는 같은 응답 — 토큰을 넣어보고 계정 존재를 알아내지 못하게(session.js 와 같은 규칙).
    if (!user) return json(res, 401, { ok: false, recorded: false, reason: 'invalid_session' });
    if (body.email !== undefined) {
      const claimed = normalizeEmail(body.email);
      if (!isValidEmail(claimed) || claimed !== user.email) {
        return json(res, 401, { ok: false, recorded: false, reason: 'invalid_session' });
      }
    }

    const now = new Date();
    const plan = user.plan || 'event_free';
    // ★배열로 쌓지 않는다 — 매일 쓰는 사람의 문서가 무한히 자란다(download.js 와 같은 판단).
    //   「고디브 쓰는 사람」은 { 'usage.godiv.count': { $gte: 1 } } 로 뽑는다.
    await db.collection('users').updateOne({ email: user.email }, {
      $set: {
        'usage.godiv.lastAt': now,
        'usage.godiv.lastSite': site,
        'usage.godiv.lastPlan': plan,
      },
      $inc: {
        'usage.godiv.count': 1,
        'usage.godiv.images': images,
        [`usage.godiv.sites.${site}`]: 1,
      },
      // firstAt 은 «처음 한 번만». $setOnInsert 는 upsert 전용이라 못 쓴다 — 없을 때만 따로 친다.
      $min: { 'usage.godiv.firstAt': now },
    });

    const count = ((user.usage && user.usage.godiv && user.usage.godiv.count) || 0) + 1;
    return json(res, 200, { ok: true, recorded: true, count });
  } catch (err) {
    console.error('[godiv/use] error', err);
    // ⛔기록 실패로 사용자의 다운로드를 되돌리지 않는다 — 확장은 이미 파일을 저장한 뒤다.
    return json(res, 200, { ok: false, recorded: false, reason: 'internal_error' });
  }
};
