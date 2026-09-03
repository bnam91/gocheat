const bcrypt = require('bcryptjs');
const { getDb } = require('../_lib/mongo');
const {
  json, handlePreflight, readJsonBody, isStrongEnough,
  normalizeEmail,
} = require('../_lib/util');
const { sha256hex } = require('../_lib/crypto');

// 비밀번호 재설정 «확정» — 1회용 토큰을 소비하고 새 비밀번호를 박는다.
//
// ★이 파일의 본체는 «비밀번호를 바꾸는 것»이 아니라 «남의 세션을 끊는 것»이다.
//   비밀번호만 갈고 세션을 남기면, 계정을 되찾으려는 그 순간에도
//   침입자는 여전히 로그인 상태다. 되찾기가 되찾기가 아니게 된다.

const TOKEN_RE = /^[a-f0-9]{64}$/;   // randomToken(32) 의 산물. verify.js:35 와 달리 길이를 «정확히» 안다.

// ★findOneAndUpdate 의 반환 «모양»이 드라이버 세대마다 다르다.
//   mongodb 4~5.x: { value, lastErrorObject, ok }   /  6.x 기본: 문서 그 자체(또는 null)
//   라이브 EC2 의 드라이버 세대를 코드가 가정하면 「매치했는데 못 찾은 걸로 읽는」 사고가 난다.
//   ⇒ 양쪽을 다 받아낸다. lastErrorObject 가 있으면 4~5.x 모양이다.
function unwrap(r) {
  if (r && typeof r === 'object' && 'lastErrorObject' in r) return r.value || null;
  return r || null;
}

module.exports = async (req, res) => {
  // reset-request.js 와 같은 이유로 브라우저 전용 · 쿠키 미사용.
  if (handlePreflight(req, res, { origin: '*' })) return;
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });
  res.setHeader('Access-Control-Allow-Origin', '*');

  let body;
  try { body = await readJsonBody(req); }
  catch (err) { return json(res, 400, { error: 'invalid_body', detail: err.message }); }

  const token = typeof body.token === 'string' ? body.token.trim().toLowerCase() : '';
  const password = body.password;

  if (!TOKEN_RE.test(token)) return json(res, 400, { ok: false, reason: 'invalid_token' });
  // ★signup.js:72 와 «같은 함수»를 쓴다. 규칙이 갈리면
  //   「재설정은 됐는데 가입 규칙엔 안 맞는」 계정이 조용히 생긴다.
  if (!isStrongEnough(password)) return json(res, 400, { ok: false, reason: 'weak_password' });

  try {
    const db = await getDb();
    const users = db.collection('users');
    const now = new Date();
    const hash = sha256hex(token);

    // ★해싱을 «조회 전»에 끝낸다. bcrypt 는 수백 ms 씩 먹는데, 그걸 매치 «성공한 뒤»에만
    //   돌리면 성공/실패의 응답 시간이 갈려 그 차이로 「유효한 토큰인지」를 재볼 수 있다.
    const passwordHash = await bcrypt.hash(password, 10);

    // ★★«조회 + 소비»를 원자적 한 번으로 한다.
    //   ⛔findOne → updateOne 2단계로 짜면 동시 요청 2건이 «둘 다» 통과한다
    //     (둘 다 findOne 에서 유효한 토큰을 보고, 둘 다 쓴다). 1회용이 1회용이 아니게 된다.
    //   조건에 만료시각을 넣었으므로, 매치되는 순간 그 토큰은 «유효했고 이제 사라졌다»가 동시에 참이다.
    // ★2026-09-04: email 을 «같이 보냈으면» 대조한다(session.js 와 같은 규약).
    //   예전엔 토큰만 봤다. 그래서 «다른 계정 이메일 + 이 토큰» 요청이 ok:true 로 돌아오면서
    //   실제로는 «토큰 주인의» 비밀번호가 바뀌었다(2026-09-04 실측). 권한 상승은 아니다 —
    //   토큰이 비밀이라 그 토큰을 쥔 사람은 어차피 주인의 비번을 바꿀 수 있다.
    //   ⛔문제는 «응답이 거짓말을 한다»는 것이다: 바뀌지 않은 계정을 바꿨다고 답한다.
    //   ⓘ우리 reset-password.html 은 { token, password } 만 보내므로 화면으로는 닿지 않는 길이다.
    //     그래도 막는다 — 앱·구버전 폼이 email 을 얹기 시작하면 «조용히» 어긋나기 때문이다.
    const claimedEmail = body.email === undefined ? null : normalizeEmail(body.email);

    const r = await users.findOneAndUpdate(
      {
        resetTokenHash: hash,
        resetTokenExpiresAt: { $gt: now },
        ...(claimedEmail ? { email: claimedEmail } : {}),
      },
      {
        $set: {
          passwordHash,
          passwordChangedAt: now,
          updatedAt: now,
          // ★★세션 모델이 «둘» 있다 — 라이브(/opt/goditor-api/api/_lib/sessions.js)는
          //   users.sessions[] 배열(제품별 칸)이고, 이 레포 main 은 users.sessionToken 단일 칸이다.
          //   둘을 «동시에» 비워야 어느 버전이 돌든 세션이 실제로 끊긴다.
          sessions: [],
        },
        $unset: {
          resetTokenHash: '', resetTokenExpiresAt: '', resetRequestedAt: '',
          sessionToken: '', sessionIssuedAt: '',
        },
      },
      { includeResultMetadata: false },
    );

    const user = unwrap(r);
    if (!user) {
      // ★만료와 무효를 «구분해서» 답한다.
      //   여기엔 열거 위험이 없다 — 토큰은 32바이트 난수라 «존재 자체»가 비밀이 아니고,
      //   추측으로 여기까지 올 수 없다. 반대로 구분해 주면 「다시 요청하세요」라는
      //   정확한 안내가 가능해진다(만료인데 「링크가 틀렸다」고 하면 사용자가 헤맨다).
      // ★email 대조로 떨어진 건 «만료»가 아니다 — 여기에도 같은 조건을 걸어야
      //   「만료됐다」는 «틀린» 안내가 나가지 않는다(2026-09-04 실측: 안 걸면 410 만료로 답한다).
      const stale = await users.findOne(
        { resetTokenHash: hash, ...(claimedEmail ? { email: claimedEmail } : {}) },
        { projection: { _id: 1 } },
      );
      if (stale) return json(res, 410, { ok: false, reason: 'expired_token' });
      return json(res, 400, { ok: false, reason: 'invalid_token' });
    }

    // ★verified 는 건드리지 않는다. EVENT_MODE 로 전원 true 라 실익이 없고,
    //   손대면 「토큰 클릭 = 메일 소유 증명」이라는 «별개 정책»을 이 파일이 몰래 만드는 셈이 된다.
    //   필요해지면 그때 명시적으로 넣는다.
    // ★새 비밀번호가 기존과 같아도 막지 않는다. 막으려면 bcrypt.compare 가 한 번 더 들고,
    //   「원래 쓰던 걸 다시 쓰려던」 사용자를 이유 없이 세운다. 보안상 얻는 것이 없다.
    return json(res, 200, { ok: true });
  } catch (err) {
    // ⛔토큰·비밀번호를 로그에 남기지 않는다.
    console.error('[reset-confirm] error', err && err.message);
    return json(res, 500, { ok: false, reason: 'internal_error' });
  }
};
