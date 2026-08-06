const { getDb } = require('../_lib/mongo');
const { json, handlePreflight, readJsonBody } = require('../_lib/util');

const MAX_TRIES = 5;              // 같은 번호로 1시간에 5번
const WINDOW_MS = 60 * 60 * 1000;
const MIN_MS = 700;               // 응답 시간을 고르게 (아래 설명)

// 가입한 이메일(=아이디) 찾기. 이름 + 휴대전화로 대조한다.
//
// ★결과는 반드시 «마스킹»해서 준다.
//   정확한 주소를 그대로 뱉으면, 남의 이름·번호를 아는 사람이 그 사람 이메일을 얻는다.
//   마스킹하면 본인은 "아, 그 계정이구나"를 알아보지만 남에게 넘길 정보는 못 된다.
//
// ★찾았을 때와 못 찾았을 때의 «응답 시간»을 고르게 맞춘다.
//   DB 조회가 빨리 끝나면 "없음"이 즉시 오고 "있음"은 느리게 오는 식으로
//   시간차가 생기는데, 그 차이만으로 가입 여부를 알아낼 수 있다.
//
// ★시도 제한을 둔다. 무제한이면 이름+번호 조합을 계속 찔러볼 수 있다.
//   지금 규모엔 과해 보이지만, 이 엔드포인트는 «남의 정보»를 다루므로
//   규모가 작다는 이유로 빼면 안 된다. 비용도 조회 한 번이다.
function maskEmail(email) {
  const at = email.indexOf('@');
  if (at < 1) return '****';
  const local = email.slice(0, at);
  const domain = email.slice(at);
  const keep = Math.min(2, local.length);
  return local.slice(0, keep) + '*'.repeat(Math.max(4, local.length - keep)) + domain;
}

const onlyDigits = (v) => (typeof v === 'string' ? v.replace(/[^0-9]/g, '') : '');

module.exports = async (req, res) => {
  if (handlePreflight(req, res, { origin: '*' })) return;
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });
  res.setHeader('Access-Control-Allow-Origin', '*');

  const started = Date.now();
  const settle = async (status, body) => {
    const wait = MIN_MS - (Date.now() - started);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    return json(res, status, body);
  };

  let body;
  try { body = await readJsonBody(req); }
  catch (err) { return json(res, 400, { error: 'invalid_body', detail: err.message }); }

  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 40) : '';
  const phone = onlyDigits(body.phone).slice(0, 15);

  // 거절도 200 + ok:false — 이 사이트의 다른 엔드포인트와 같은 축
  if (!name || phone.length < 10) {
    return settle(200, { ok: false, reason: 'invalid_input' });
  }

  try {
    const db = await getDb();

    // 시도 제한 (번호 기준). 성공·실패 모두 센다 — 성공만 세면 무의미하다.
    const tries = db.collection('find_attempts');
    const since = new Date(Date.now() - WINDOW_MS);
    const used = await tries.countDocuments({ phone, at: { $gte: since } });
    if (used >= MAX_TRIES) {
      return settle(200, { ok: false, reason: 'too_many_attempts' });
    }
    await tries.insertOne({ phone, at: new Date() });

    const user = await db.collection('users').findOne(
      { 'profile.name': name, 'profile.phone': phone },
      { projection: { email: 1, createdAt: 1 } },
    );

    if (!user) return settle(200, { ok: false, reason: 'not_found' });

    return settle(200, {
      ok: true,
      email: maskEmail(user.email),        // ★원본을 주지 않는다
      joinedAt: user.createdAt || null,
    });
  } catch (err) {
    console.error('[find-email] error', err);
    return settle(500, { ok: false, reason: 'internal_error' });
  }
};
