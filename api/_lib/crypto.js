const crypto = require('crypto');

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
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

module.exports = { randomToken, makeLicenseKey };
