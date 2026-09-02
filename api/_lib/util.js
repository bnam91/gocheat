// ★★2026-09-02: 옛 식 /^[^\s@]+@[^\s@]+\.[^\s@]+$/ 은 «너무 헐거웠다».
//   현빈이 'coq3820@gmail.comㄴㅇ' 로 중복확인을 눌렀는데 「사용할 수 있는 이메일」이 떴다 —
//   [^\s@] 는 한글도 허용해서 「comㄴㅇ」이 TLD 로 통과했기 때문이다.
//   그 밖에 a@b..com(빈 마디)·a@b.c1(숫자 TLD)·a@b-.com(하이픈 끝) 도 통과했다.
//   ⇒ ASCII 만 · 도메인 마디는 영숫자로 시작·끝 · TLD 는 «영문 2~63자».
//   ⚠️국제화 주소(한글@도메인.한국)는 «거절»한다. RFC 상 존재하지만 우리 발송 경로가
//     처리하지 못하므로, 받아 두고 메일을 못 보내는 것보다 «입력 시점에» 막는 편이 낫다.
//   ⛔이 식은 signup.html·goditor.html 의 emailRe 와 «같은 값»이어야 한다.
//     한쪽만 고치면 화면과 서버 판정이 갈려 「화면은 통과, 서버는 거절」이 된다.
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

module.exports = {
  json,
  setCors,
  handlePreflight,
  readJsonBody,
  isValidEmail,
  normalizeEmail,
  isStrongEnough,
};
