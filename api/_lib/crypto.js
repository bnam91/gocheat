const crypto = require('crypto');

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

// ★단방향 요약. «되돌릴 수 없는 형태로 보관»해야 하는 값에 쓴다.
//   현재 용도: 비밀번호 재설정 토큰(api/license/reset-*.js).
//   DB 에는 이 해시만 넣고 평문 토큰은 링크로만 존재한다 — DB 가 새도 그 토큰으로는
//   아무 데도 못 들어간다. 비밀번호에는 쓰지 말 것(그건 bcrypt 다) — 여기 들어오는 값은
//   32바이트 CSPRNG 라 사전공격이 성립하지 않아 salt 가 필요 없는 것이고,
//   사람이 고른 비밀번호는 그 전제가 깨진다.
function sha256hex(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

// Crockford-style base32 (no I/L/O/U), 4 groups of 4 chars → 'SO-XXXX-XXXX-XXXX-XXXX'
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function makeLicenseKey() {
  const buf = crypto.randomBytes(10);
  let bits = 0;
  let bitCount = 0;
  let out = '';
  for (const byte of buf) {
    bits = (bits << 8) | byte;
    bitCount += 8;
    while (bitCount >= 5 && out.length < 16) {
      bitCount -= 5;
      out += ALPHABET[(bits >> bitCount) & 31];
    }
  }
  while (out.length < 16) out += ALPHABET[Math.floor(Math.random() * 32)];
  return `SO-${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8, 12)}-${out.slice(12, 16)}`;
}

module.exports = { randomToken, sha256hex, makeLicenseKey };
