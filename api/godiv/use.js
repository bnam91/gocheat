const { getDb } = require('../_lib/mongo');
const { findUserBySession } = require('../_lib/sessions');
const { effectiveFor } = require('../_lib/entitlements');
const { json, handlePreflight, readJsonBody, isValidEmail, normalizeEmail } = require('../_lib/util');

/* 고디브(크롬 확장) «사용 기록» — 누가·언제·어디서·몇 장 받았고 «성공했는지»까지 남긴다.
 *
 * ★왜 필요한가 (2026-08-25, 현빈 지시)
 *   지금까지 DB 는 「이 회원이 고디브를 쓴다」를 몰랐다. 확장이 부르는 건 login·session·banner 뿐인데
 *   · login   = 제품 구분 없이 lastLoginAt 만 갱신(고디터 앱·홈페이지 로그인과 구별 불가)
 *   · session = ⛔«조회 전용»이다. 거기에 기록을 얹으면 확인용 엔드포인트가 계측기가 된다(session.js 주석).
 *   ⇒ 세는 일을 «여기»로 분리한다. 확인(session)과 계측(use)은 끝까지 다른 문이어야 한다.
 *
 * ★두 곳에 쓴다 — 목적이 다르다. 한쪽으로 합치려 하지 마라.
 *   ① users.usage.godiv.*  = «계정 요약»(누적 카운터). 회원 목록에 바로 붙여 보는 값.
 *      ⛔여기에 배열을 쌓지 마라 — 매일 쓰는 사람의 문서가 무한히 자란다(download.js 와 같은 판단).
 *   ② godiv_events         = «시계열 원장»(1건 1도큐먼트). 추이·재방문·사이트별 성공률은 여기서만 나온다.
 *      TTL 인덱스로 자동 소멸한다(_lib/mongo.js). 원장이 영구 보관이 되면 그건 다른 약속이다.
 *
 * ★실패도 «반드시» 기록한다 (1단계의 핵심 가치).
 *   expected(찾은 장수) 와 ok(받은 장수)를 같이 받아 result 를 서버가 판정한다.
 *   사이트별 성공률이 갑자기 무너지면 그건 사용량 얘기가 아니라 «어댑터가 깨졌다»는 신호다.
 *   와디즈 wadiz.kr→wadiz.io 이관 때 우리는 그걸 며칠 몰랐다(HANDOFF §6.7). 그 눈을 여기서 만든다.
 *
 * ★언제 부르나 = 다운로드 «시도가 끝난 직후» 1회(성공·부분·0장 모두).
 *   페이지를 열 때마다 부르면 «열어만 본 사람»이 섞여 숫자가 오염된다 — 그 시점으로 옮기지 마라.
 *
 * ⛔수집 범위 (처리방침과 «한 글자도» 어긋나면 안 된다 — godiv.html#privacy)
 *   보내는 것 = 지원 사이트 식별자(naver|coupang|wadiz|other) · 장수 · 성공여부 · 시각.
 *   ⛔URL·상품명·페이지 내용은 «받지도 저장하지도» 않는다. 본문에 섞여 와도 무시한다.
 *   고유 페이지 수(pageHash)는 2단계 안건이고, 그때는 공시를 «먼저» 고쳐야 한다.
 *
 * 입력  { sessionToken, email?, site, expected?, ok? }   ※ images 는 ok 의 옛 이름(호환)
 * 출력  { ok, recorded, result, count, reason? }
 */

// 지원 사이트 화이트리스트 — 밖은 'other'. 클라이언트 문자열이 필드를 오염시키지 못하게.
const SITES = ['naver', 'coupang', 'wadiz'];
// 장수 상한 — 오타·조작으로 합계가 튀지 않게.
const MAX_IMAGES = 5000;
/* ★계정당 최소 간격 (2026-08-25 2차 검수 M3).
 *   전엔 호출 «횟수» 제한이 없어, 로그인만 한 사람이 이 문을 반복해 두드려
 *   자기 usage.godiv.* 와 원장을 마음대로 부풀릴 수 있었다.
 *   ⇒ 이 지표의 용도 중 하나가 «계정 부정사용 방지»인데 지표 자체가 자가조작 가능하면 쓸모가 없다.
 *   실제 다운로드는 아무리 짧아도 수 초가 걸린다 — 3초는 정상 사용을 막지 않는다.
 *   ★판정은 «DB 필터»로 한다(읽고 비교하면 그 사이에 또 들어온다). */
const MIN_INTERVAL_MS = 3000;

function clampCount(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), MAX_IMAGES) : 0;
}

module.exports = async (req, res) => {
  if (handlePreflight(req, res, { origin: '*' })) return;
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });
  res.setHeader('Access-Control-Allow-Origin', '*');

  let body;
  try { body = await readJsonBody(req); }
  catch (err) { return json(res, 400, { error: 'invalid_body', detail: err.message }); }

  const sessionToken = typeof body.sessionToken === 'string' ? body.sessionToken.trim() : '';
  if (!sessionToken) return json(res, 401, { ok: false, recorded: false, reason: 'invalid_session' });

  const asked = typeof body.site === 'string' ? body.site.trim().toLowerCase() : '';
  const site = SITES.includes(asked) ? asked : 'other';
  const ok = clampCount(body.ok !== undefined ? body.ok : body.images);
  // expected 가 안 왔거나 ok 보다 작으면 ok 로 맞춘다 — «받은 게 찾은 것보다 많다»는 모순을 남기지 않는다.
  const expected = Math.max(clampCount(body.expected), ok);
  // 판정은 «서버가» 한다. 클라이언트가 보낸 라벨을 믿으면 성공률이 조작 가능해진다.
  const result = ok === 0 ? 'none' : (ok < expected ? 'partial' : 'ok');

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
    // ★2026-08-25 ③-1: 통계 라벨을 «godiv 앱» 자격으로(전역 plan 아님). 「godiv 유·무료 사용」 분석 오염 방지.
    const plan = effectiveFor(user, 'godiv').plan;

    // ── ① 계정 요약 ────────────────────────────────────────────────────────
    // 「고디브 쓰는 회원」 = { 'usage.godiv.count': { $gte: 1 } }
    // ★count 는 «성공한 다운로드»만 센다. 0장 시도까지 섞으면 「몇 번 받았나」가 거짓말이 된다.
    //   시도 전체는 attempts, 실패는 failed 로 따로 센다 — 셋을 한 칸에 합치지 마라.
    const inc = { 'usage.godiv.attempts': 1 };
    const set = { 'usage.godiv.lastAttemptAt': now, 'usage.godiv.lastPlan': plan };
    if (ok > 0) {
      inc['usage.godiv.count'] = 1;
      inc['usage.godiv.images'] = ok;
      inc[`usage.godiv.sites.${site}`] = 1;
      set['usage.godiv.lastAt'] = now;
      set['usage.godiv.lastSite'] = site;
    } else {
      inc['usage.godiv.failed'] = 1;
      set['usage.godiv.lastFailAt'] = now;
      set['usage.godiv.lastFailSite'] = site;
    }
    // ★스로틀 — «마지막 시도가 3초보다 오래됐을 때만» 갱신된다. 조건을 갱신 필터에 넣어 원자적으로 판정한다.
    const cutoff = new Date(now.getTime() - MIN_INTERVAL_MS);
    const r = await db.collection('users').updateOne({
      email: user.email,
      $or: [
        { 'usage.godiv.lastAttemptAt': { $exists: false } },
        { 'usage.godiv.lastAttemptAt': { $lte: cutoff } },
      ],
    }, {
      $set: set,
      $inc: inc,
      // firstAt 은 «처음 한 번만». $setOnInsert 는 upsert 전용이라 못 쓴다 — $min 이 같은 일을 원자적으로 한다.
      $min: { 'usage.godiv.firstAt': now },
    });
    // ⛔너무 잦은 호출은 «조용히 무시»하되 사용자에게는 실패로 보이지 않게 한다(기록은 부가지 관문이 아니다).
    //   ★원장에도 안 넣는다 — 요약만 막고 원장을 채우면 그쪽으로 부풀릴 수 있다.
    if (!r.matchedCount) return json(res, 200, { ok: true, recorded: false, throttled: true, result });

    // ── ② 시계열 원장 ──────────────────────────────────────────────────────
    // ★요약 갱신이 끝난 «뒤에» 넣고, 실패해도 위 카운터를 되돌리지 않는다.
    //   둘 다 맞으면 최고고, 하나만 남으면 요약이 남는 게 낫다(회원 목록이 우선이다).
    let logged = false;
    try {
      await db.collection('godiv_events').insertOne({
        email: user.email, at: now, site, expected, ok, result, plan,
        // ⛔URL·상품명은 넣지 않는다. 넣고 싶어지면 처리방침·웹스토어 공시부터 고쳐라.
      });
      logged = true;
    } catch (e) {
      console.error('[godiv/use] event insert failed', e && e.message);
    }

    const count = ((user.usage && user.usage.godiv && user.usage.godiv.count) || 0) + (ok > 0 ? 1 : 0);
    return json(res, 200, { ok: true, recorded: true, logged, result, count });
  } catch (err) {
    console.error('[godiv/use] error', err);
    // ⛔기록 실패로 사용자의 다운로드를 되돌리지 않는다 — 확장은 이미 파일을 저장한 뒤다.
    return json(res, 200, { ok: false, recorded: false, reason: 'internal_error' });
  }
};
