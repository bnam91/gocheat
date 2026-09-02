const bcrypt = require('bcryptjs');
const { getDb } = require('../_lib/mongo');
const { json, handlePreflight, readJsonBody, isStrongEnough } = require('../_lib/util');

/* 로그인한 사용자가 «그 자리에서» 비밀번호를 바꾼다.
 *
 * ★왜 필요한가 (2026-09-02, 현빈 지시)
 *   전에는 마이페이지의 「재설정 요청 →」이 find-password.html 로 보냈다. 그러면
 *   ★이미 로그인해서 «본인임이 증명된» 사람이 「비밀번호를 잊었다」 흐름을 다시 타고,
 *     메일 발송기가 없어 담당자가 링크를 손으로 보내줄 때까지 기다려야 했다.
 *   비밀번호 «변경»은 이벤트·판매와 무관한 «기본기»다 — 로그인한 사람은 즉시 바꿀 수 있어야 한다.
 *
 * ★reset-confirm.js 와 무엇이 다른가
 *   저쪽은 «1회용 토큰»으로 본인을 증명하고(비밀번호를 모르는 사람), 이쪽은 «현재 비밀번호»로 증명한다.
 *   그래서 이쪽에는 토큰이 없고, 대신 «무차별 대입»이 가능하다 — 그게 아래 레이트리밋이 있는 이유다.
 *
 * ★공통점: 바꾼 뒤 «모든 세션을 끊는다». 비밀번호만 갈고 세션을 남기면,
 *   비밀번호를 바꾼 이유(누가 내 계정에 들어와 있다)가 그대로 남는다.
 */

// ★한 번에 세 번까지. reset-request.js 와 «같은 컬렉션»(reset_attempts)을 쓰되 키 접두어로 가른다 —
//   그 컬렉션에는 이미 TTL 인덱스(2시간)가 걸려 있어 청소가 저절로 된다(_lib/mongo.js).
const WINDOW_MS = 15 * 60 * 1000;
const MAX_PER_USER = 5;
const MAX_PER_IP = 15;

function clientIp(req) {
  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf.trim()) return cf.trim().slice(0, 64);
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) return xff.split(',')[0].trim().slice(0, 64);
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

// ★findOneAndUpdate 반환 «모양»이 드라이버 세대마다 다르다(4~5.x 는 래퍼, 6.x 는 문서 자체).
//   reset-confirm.js 와 «같은» 함수를 쓴다 — 한쪽만 고치면 다른 쪽이 조용히 깨진다.
function unwrap(r) {
  if (r && typeof r === 'object' && 'lastErrorObject' in r) return r.value || null;
  return r || null;
}

module.exports = async (req, res) => {
  if (handlePreflight(req, res, { origin: '*' })) return;
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });
  res.setHeader('Access-Control-Allow-Origin', '*');

  let body;
  try { body = await readJsonBody(req); }
  catch (err) { return json(res, 400, { error: 'invalid_body', detail: err.message }); }

  const sessionToken = typeof body.sessionToken === 'string' ? body.sessionToken.trim() : '';
  const currentPassword = body.currentPassword;
  const newPassword = body.newPassword;

  if (!sessionToken) return json(res, 401, { ok: false, reason: 'invalid_session' });
  if (typeof currentPassword !== 'string' || !currentPassword) {
    return json(res, 400, { ok: false, reason: 'current_required' });
  }
  // ★signup.js·reset-confirm.js 와 «같은 함수»로 센다. 규칙이 갈리면
  //   「변경으로는 통과하는데 가입 규칙엔 안 맞는」 비밀번호가 조용히 생긴다.
  if (!isStrongEnough(newPassword)) return json(res, 400, { ok: false, reason: 'weak_password' });
  if (newPassword === currentPassword) {
    return json(res, 400, { ok: false, reason: 'same_password' });
  }

  try {
    const db = await getDb();
    const users = db.collection('users');
    const now = new Date();

    // ★세션 모델이 «둘» 있다 — 라이브는 users.sessions[] 배열, 레포 main 은 users.sessionToken 단일 칸.
    //   둘 다 조회해야 어느 버전이 돌든 로그인 상태를 알아본다(라이브 _lib/sessions.js:66-68 과 같은 질의).
    const user = await users.findOne({
      $or: [{ sessionToken }, { 'sessions.token': sessionToken }],
    });
    if (!user) return json(res, 401, { ok: false, reason: 'invalid_session' });

    // ★시도 제한은 «비밀번호를 대조하기 전»에 센다. 대조 뒤에 세면
    //   맞은 경우와 틀린 경우의 처리 시간이 갈려 그 차이가 곧 신호가 된다.
    const since = new Date(now.getTime() - WINDOW_MS);
    const attempts = db.collection('reset_attempts');
    const ip = clientIp(req);
    const [byUser, byIp] = await Promise.all([
      attempts.countDocuments({ key: `pw:${user.email}`, at: { $gte: since } }),
      attempts.countDocuments({ key: `pwip:${ip}`, at: { $gte: since } }),
    ]);
    if (byUser >= MAX_PER_USER || byIp >= MAX_PER_IP) {
      return json(res, 429, { ok: false, reason: 'too_many_attempts' });
    }
    await attempts.insertMany([
      { key: `pw:${user.email}`, at: now },
      { key: `pwip:${ip}`, at: now },
    ]);

    const okCurrent = await bcrypt.compare(currentPassword, user.passwordHash || '');
    if (!okCurrent) return json(res, 401, { ok: false, reason: 'wrong_current_password' });

    const passwordHash = await bcrypt.hash(newPassword, 10);

    // ★«확인 + 교체 + 세션차단»을 한 번의 원자 연산으로.
    //   조건에 «지금 그 세션이 아직 유효한지»를 다시 넣는다 — 위 findOne 이후에
    //   다른 경로(재설정·로그아웃)로 세션이 끊겼다면 여기서 매치가 실패해야 한다.
    const r = await users.findOneAndUpdate(
      { _id: user._id, $or: [{ sessionToken }, { 'sessions.token': sessionToken }] },
      {
        $set: {
          passwordHash,
          passwordChangedAt: now,
          updatedAt: now,
          sessions: [],                       // 라이브 모델(배열)
        },
        $unset: {
          sessionToken: '', sessionIssuedAt: '',   // 레포 main 모델(단일 칸)
          resetTokenHash: '', resetTokenExpiresAt: '', resetRequestedAt: '',
        },
      },
      { includeResultMetadata: false },
    );
    if (!unwrap(r)) return json(res, 401, { ok: false, reason: 'invalid_session' });

    // ★성공했으면 시도 기록을 지운다 — 「바꾸고 나서 또 바꾸려니 막히는」 상황을 안 만든다.
    await attempts.deleteMany({ key: `pw:${user.email}` }).catch(() => {});

    // ⛔새 세션을 «주지 않는다». 다시 로그인하게 하는 것이 이 엔드포인트의 목적 절반이다.
    return json(res, 200, { ok: true, reloginRequired: true });
  } catch (err) {
    console.error('[change-password]', err && err.message);
    return json(res, 500, { ok: false, reason: 'internal_error' });
  }
};
