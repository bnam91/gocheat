const { getDb } = require('../_lib/mongo');
const { json, handlePreflight, readJsonBody, isValidEmail, normalizeEmail } = require('../_lib/util');

// 이메일 «중복 확인» — 회원가입 폼의 [중복확인] 버튼이 부른다.
//
// ★★이 파일은 «일부러» 가입 여부를 알려준다. 우리 다른 엔드포인트(find-email·reset-request·signup)는
//   전부 반대로 «절대 안 알려주는» 쪽으로 만들어져 있다. 그 차이를 여기 적어 둔다.
//
//   왜 여기서만 알려주나(현빈 2026-09-02 결정):
//     ⑴가입 폼은 어차피 중복 가입을 막아야 한다 — 숨겨도 「가입이 안 된다」는 사실로 결국 드러난다.
//       완벽히 숨기려면 «가입 자체를 막지 않아야» 하는데 그건 불가능하다.
//     ⑵숨겨서 생긴 실제 피해가 훨씬 컸다. 이미 가입된 주소로 다시 가입하면 화면은 「가입 완료」라고
//       하는데 «새로 친 비밀번호는 버려진다»(signup.js 의 $setOnInsert). 그래서 사용자는
//       «있지도 않은 비밀번호»로 로그인을 시도하다 갇힌다. 2026-09-02 현빈이 직접 겪었다.
//   ⇒ 대신 «긁는 것»은 막는다: IP 당 시간당 상한을 둔다. 사람이 가입하며 몇 번 누르는 건 넉넉하고,
//     목록을 훑는 것은 못 하는 수준이다.
//
// ⛔여기서 «가입 여부» 말고 다른 것(이름·가입일·인증 여부)은 절대 돌려주지 마라.

const WINDOW_MS = 60 * 60 * 1000;
const MAX_PER_IP = 60;          // 사람: 가입 한 번에 1~3회. 60회면 넉넉하되 열거는 못 한다.

// ★cf-connecting-ip 를 먼저 본다 — TLS 종단이 Cloudflare 라 CF 가 «자기가 본» 접속 IP 를
//   그 헤더에 덮어쓴다(사용자가 못 지어낸다). XFF 는 위조 가능해 보조로만 쓴다.
//   (reset-request.js 의 clientIp 와 «같은 규칙» — 한쪽만 고치지 마라)
function clientIp(req) {
  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf.trim()) return cf.trim().slice(0, 64);
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) return xff.split(',')[0].trim().slice(0, 64);
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

module.exports = async (req, res) => {
  if (handlePreflight(req, res, { origin: '*' })) return;
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });
  res.setHeader('Access-Control-Allow-Origin', '*');

  let body;
  try { body = await readJsonBody(req); }
  catch (err) { return json(res, 400, { error: 'invalid_body', detail: err.message }); }

  const email = normalizeEmail(body.email);
  if (!isValidEmail(email)) return json(res, 400, { error: 'invalid_email' });

  try {
    const db = await getDb();
    const now = new Date();
    const ip = clientIp(req);
    const tries = db.collection('reset_attempts');   // 시도 기록은 한 컬렉션에 모은다(키 접두어로 구분)
    const since = new Date(now.getTime() - WINDOW_MS);

    const used = await tries.countDocuments({ key: `chk:${ip}`, at: { $gte: since } });
    if (used >= MAX_PER_IP) {
      // ★한도를 넘으면 «가입 여부를 말하지 않는다». 여기서 taken 을 돌려주면 상한이 무의미해진다.
      return json(res, 429, { error: 'too_many_attempts' });
    }
    await tries.insertOne({ key: `chk:${ip}`, at: now });

    const user = await db.collection('users').findOne({ email }, { projection: { _id: 1 } });
    return json(res, 200, { ok: true, taken: !!user });
  } catch (err) {
    console.error('[check-email] error', err && err.message);
    return json(res, 500, { error: 'internal_error' });
  }
};
