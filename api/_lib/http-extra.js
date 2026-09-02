/* 신고·공지 엔드포인트가 쓰는 HTTP 잡동사니.
 *
 * ★_lib/util.js 를 «고치지 않고» 옆에 둔다.
 *   util.readJsonBody 는 1MB 에서 고정으로 끊는다(그 자리는 로그인·가입에는 알맞다).
 *   신고는 캡처 이미지가 붙어 그보다 커야 하고, «거부할 때 사용자에게 보일 말»도 달라야 한다.
 *   공용 파일의 상수를 올리면 로그인 엔드포인트의 방어선까지 같이 넓어진다 — 그러면 안 된다.
 *
 * ★쿼리 파싱을 여기서 하는 이유
 *   Vercel 은 req.query 를 넣어주지만 EC2 어댑터(server/ec2-server.js)는 «협업 경로에만» 넣는다.
 *   GET 핸들러가 req.query 를 그냥 믿으면 라이브에서 전부 빈 값이 된다(실제 사고: /api/godiv/*).
 */

/** 요청 본문을 «바이트 상한»을 두고 읽는다. 상한을 넘으면 소켓을 끊고 err.tooLarge=true 로 알린다. */
async function readJsonBodyLimited(req, maxBytes) {
  if (req.body && typeof req.body === 'object') return req.body;   // Vercel 이 이미 파싱한 경우
  const limit = Number(maxBytes) || 1e6;

  // ★헤더로 «먼저» 끊는다 — 본문을 다 받고 나서 거부하면 그 메모리를 이미 다 먹은 뒤다.
  const declared = Number(req.headers['content-length'] || 0);
  if (declared && declared > limit) {
    const e = new Error('payload too large');
    e.tooLarge = true; e.declared = declared;
    throw e;
  }

  return await new Promise((resolve, reject) => {
    let raw = '';
    let bytes = 0;
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > limit) {
        const e = new Error('payload too large');
        e.tooLarge = true; e.declared = bytes;
        reject(e);
        req.destroy();
        return;
      }
      raw += chunk;
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch { reject(new Error('invalid JSON')); }
    });
    req.on('error', reject);
  });
}

/** 쿼리스트링 → 평범한 객체. req.query(Vercel)가 있으면 그걸 먼저 쓴다. */
function getQuery(req) {
  if (req.query && typeof req.query === 'object' && Object.keys(req.query).length) return req.query;
  try {
    const u = new URL(req.url || '/', 'http://localhost');
    return Object.fromEntries(u.searchParams.entries());
  } catch { return {}; }
}

/** 세션토큰을 «헤더»에서 꺼낸다.
 *  ⛔GET 의 쿼리스트링에 토큰을 싣지 마라 — nginx 액세스로그에 그대로 남는다(로그가 곧 열쇠꾸러미가 된다).
 *  POST 는 본문에 담는다(ec2-server 는 본문을 로그하지 않는다). */
function sessionTokenFromHeader(req) {
  const h = req.headers || {};
  const bearer = String(h.authorization || '');
  const m = bearer.match(/^Bearer\s+(\S+)$/i);
  if (m) return m[1];
  const x = h['x-session-token'];
  return typeof x === 'string' ? x.trim() : '';
}

/** CORS — 커스텀 헤더(x-session-token/Authorization)를 쓰는 경로용. util.setCors 는 Content-Type 만 허용한다. */
function setCorsAuth(res, methods) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', methods || 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-session-token');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function handlePreflightAuth(req, res, methods) {
  if (req.method !== 'OPTIONS') return false;
  setCorsAuth(res, methods);
  res.statusCode = 204;
  res.end();
  return true;
}

/** 클라이언트 IP — nginx 뒤라 x-forwarded-for 의 «첫» 홉이 진짜다. ⛔원문을 저장하지 않는다(로그·DB 모두). */
function clientIp(req) {
  const xff = String((req.headers && req.headers['x-forwarded-for']) || '');
  if (xff) return xff.split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || '';
}

module.exports = {
  readJsonBodyLimited, getQuery, sessionTokenFromHeader, setCorsAuth, handlePreflightAuth, clientIp,
};
