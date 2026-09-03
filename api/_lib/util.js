// ★★2026-09-02: 옛 식 /^[^\s@]+@[^\s@]+\.[^\s@]+$/ 은 «너무 헐거웠다».
//   현빈이 'coq3820@gmail.comㄴㅇ' 로 중복확인을 눌렀는데 「사용할 수 있는 이메일」이 떴다 —
//   [^\s@] 는 한글도 허용해서 「comㄴㅇ」이 TLD 로 통과했기 때문이다.
//   그 밖에 a@b..com(빈 마디)·a@b.c1(숫자 TLD)·a@b-.com(하이픈 끝) 도 통과했다.
//   ⇒ ASCII 만 · 도메인 마디는 영숫자로 시작·끝 · TLD 는 «영문 2~63자».
//   ⚠️국제화 주소(한글@도메인.한국)는 «거절»한다. RFC 상 존재하지만 우리 발송 경로가
//     처리하지 못하므로, 받아 두고 메일을 못 보내는 것보다 «입력 시점에» 막는 편이 낫다.
//   ⛔이 식은 signup.html·goditor.html 의 emailRe 와 «같은 값»이어야 한다.
//     한쪽만 고치면 화면과 서버 판정이 갈려 「화면은 통과, 서버는 거절」이 된다.
/* ★★전화번호 정규화 — «네 곳이 따로» 하던 것을 하나로 모은다(2026-09-04).
 *   signup.js · reset-request.js(입력·저장값) · find-email.js 가 각각 숫자만 남기고 있었는데,
 *   ⛔국가번호를 아무도 안 봤다. 그래서 «+82 10-1111-0004» 로 가입한 사람이
 *     「01011110004」로 비밀번호를 찾으면 «영영 못 찾았다»(2026-09-04 실측).
 *     화면은 열거 방지 때문에 「접수됐다」고 말해서, 그 사람은 이유도 모른 채 헤맨다.
 *
 * ★판정 규칙: «82 로 시작하고 그 다음이 0 이 아니면» 국가번호로 본다.
 *   국내 번호는 «전부 0 으로 시작»한다(010·02·031…). 그래서 82 뒤에 0 이 아닌 숫자가 오면
 *   그건 국가번호를 뗀 형태다 — 앞에 0 을 붙여 국내 형식으로 되돌린다.
 *     821011110004 → 0 + 1011110004 = 01011110004   (휴대폰)
 *     82212345678  → 0 + 212345678  = 0212345678    (서울)
 *   ⚠️국내 번호가 82 로 시작할 일은 없다. 이 규칙이 국내 번호를 망가뜨리지 않는 근거다.
 *
 * ⛔이 함수를 «복사»하지 마라. 네 곳이 따로 하다가 이 버그가 났다. 여기서 import 해라. */
function normalizePhone(v) {
  let d = String(v == null ? '' : v).replace(/[^0-9]/g, '').slice(0, 20);
  if (d.length >= 10 && d.startsWith('82') && d[2] !== '0') d = '0' + d.slice(2);
  return d.slice(0, 15);
}

const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,63}$/;

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function setCors(res, { origin = '*', methods = 'POST, OPTIONS' } = {}) {
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', methods);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function handlePreflight(req, res, opts) {
  if (req.method !== 'OPTIONS') return false;
  setCors(res, opts);
  res.statusCode = 204;
  res.end();
  return true;
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return await new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1e6) {
        reject(new Error('payload too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch { reject(new Error('invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function isValidEmail(value) {
  return typeof value === 'string' && value.length <= 254 && EMAIL_RE.test(value);
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function isStrongEnough(password) {
  return typeof password === 'string' && password.length >= 8 && password.length <= 200;
}

module.exports = { normalizePhone,
  json,
  setCors,
  handlePreflight,
  readJsonBody,
  isValidEmail,
  normalizeEmail,
  isStrongEnough,
};
