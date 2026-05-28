const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
