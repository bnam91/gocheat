const { getDb } = require('../_lib/mongo');
const {
  json, handlePreflight, readJsonBody,
  isValidEmail, normalizeEmail,
} = require('../_lib/util');
const { randomToken, sha256hex } = require('../_lib/crypto');
const { enqueueMail, buildResetMail } = require('../_lib/mail');

// 비밀번호 재설정 «요청» — 이메일 한 칸을 받아 1회용 링크를 발급한다.
//
// ★이 파일이 지켜야 하는 것은 «무엇을 말하지 않는가»다.
//   가입된 주소인지 아닌지를 어떤 경로로도 흘리면 안 된다. 흘리는 경로는 세 개다:
//     ① 응답 body  ② HTTP status  ③ ★응답 «시간»
//   앞의 둘은 아래에서 항상 같은 값을 돌려주는 것으로 막고, 셋째는 settle() 로 막는다.
//   (find-email.js:14-16 이 같은 이유로 같은 장치를 두었다 — 그 패턴을 그대로 가져왔다)
//
// ★메일은 mailerLive 가 켜져 있을 때만 큐에 넣는다.
//   지금 이 조직엔 mail_queue 를 «꺼내 보내는» 주체가 없다(_lib/collab-handlers/invite.js:16-18).
//   끄고 쌓아두면 훗날 발송기가 붙는 날 «만료된 재설정 링크»가 무더기로 나간다.
//   signup.js:161 이 같은 판단을 이미 적어 뒀다 — 「보내지도 못할 인증메일을 큐에 쌓지 않는다」.

const MIN_MS = 700;                        // 응답 시간 평탄화 하한 (find-email.js:6 과 동일)
const TOKEN_TTL_MS = 30 * 60 * 1000;       // ★30분. verify.js 의 24시간과 «다르게» 짧다 —
                                           //   가입 확인과 달리 재설정은 계정 통제권에 직결된다.
const WINDOW_MS = 60 * 60 * 1000;
const MAX_PER_EMAIL = 3;                   // 같은 이메일로 1시간에 3회
const MAX_PER_IP = 10;                     // 같은 IP 로 1시간에 10회

// ★배포 분리 스위치 — signup.js:49 와 «같은 파일»을 본다.
//   레포 파일이라 정적 require 로 번들에 실린다. 켜고 끄는 건 커밋 한 줄이다.
//   ⚠️정적 require 라 «프로세스 재시작» 전에는 값이 안 바뀐다(EC2 는 systemd restart 필요).
const FLAGS = require('../../data/flags.json');
const MAILER_LIVE = FLAGS.mailerLive === true;

// ★XFF 는 «위조 가능»하다 — 클라이언트가 헤더를 그냥 지어낼 수 있다.
//   그래서 ip 축은 «보조»일 뿐이고, 주 방어는 email 축이다. ip 축이 뚫려도
//   한 이메일당 3회 상한은 그대로 살아 있다.
//   cf-connecting-ip 를 먼저 보는 이유: 이 사이트의 TLS 종단이 Cloudflare 라
//   CF 가 «자기가 본» 접속 IP 를 그 헤더에 덮어쓴다(사용자가 못 지어낸다).
function clientIp(req) {
  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf.trim()) return cf.trim().slice(0, 64);
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) return xff.split(',')[0].trim().slice(0, 64);
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

module.exports = async (req, res) => {
  // ★CORS 를 여는 이유를 적어 둔다: 이 엔드포인트는 «브라우저 전용»이다(앱은 안 부른다).
  //   쿠키를 쓰지 않고 토큰도 응답에 싣지 않으므로 CSRF 로 얻어갈 것이 없다.
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

  const email = normalizeEmail(body.email);
  // ★형식 오류는 «가입 여부와 무관»하게 판정되므로 즉답해도 아무것도 새지 않는다.
  if (!isValidEmail(email)) return json(res, 400, { error: 'invalid_email' });

  // ★★본인 확인 추가(현빈 2026-09-02). 목적은 «계정 탈취 방지»가 아니다 —
  //   재설정 링크는 어차피 그 메일함으로만 가므로, 이름·전화가 있다고 탈취가 더 막히지는 않는다.
  //   진짜 목적은 «오타로 남의 주소를 넣었을 때» 애먼 사람에게 메일이 가고,
  //   그 사람이 받아 둔 재설정 링크가 덮어써져 죽는 것을 막는 것이다(아래 updateOne).
  const name  = typeof body.name === 'string' ? body.name.trim().slice(0, 40) : '';
  const phone = String(body.phone || '').replace(/\D/g, '').slice(0, 15);

  try {
    const db = await getDb();
    const now = new Date();
    const since = new Date(now.getTime() - WINDOW_MS);
    const attempts = db.collection('reset_attempts');
    const ip = clientIp(req);

    // ★시도 제한은 «계정을 찾기 전»에 센다. 찾은 뒤에 세면
    //   「없는 계정은 제한에 안 걸린다」가 되어 그 차이가 곧 열거 도구다.
    const [byEmail, byIp] = await Promise.all([
      attempts.countDocuments({ key: `email:${email}`, at: { $gte: since } }),
      attempts.countDocuments({ key: `ip:${ip}`, at: { $gte: since } }),
    ]);
    if (byEmail >= MAX_PER_EMAIL || byIp >= MAX_PER_IP) {
      // ★이 응답은 «제출된 문자열» 기준이라 계정 존재를 흘리지 않는다 —
      //   있는 계정도 없는 계정도 4회째부터 똑같이 이걸 받는다.
      return settle(200, { ok: false, reason: 'too_many_attempts' });
    }
    await attempts.insertMany([
      { key: `email:${email}`, at: now },
      { key: `ip:${ip}`, at: now },
    ]);

    const users = db.collection('users');
    const user = await users.findOne({ email }, {
      projection: { email: 1, verified: 1, 'profile.name': 1, 'profile.phone': 1 },
    });

    // ★★«정보가 저장된 계정에만» 대조한다. 왜 전면 적용이 아닌가:
    //   확장 가입(이름·휴대전화 수집)은 2026-09-02 에 열렸다. 그 전에 가입한 계정에는
    //   이름·전화가 «아예 없다» — 전면 적용하면 그 사람들은 비밀번호를 «영영» 못 찾는다.
    //   (2026-09-02 실측: 전체 14명 중 12명이 둘 중 하나 이상 없음)
    //   비밀번호 찾기는 마지막 통로라 여기서 막히면 대안이 없다.
    //   ⇒ 저장된 값이 «둘 다 있는» 계정만 대조하고, 없는 계정은 이메일만으로 통과시킨다.
    //   ★남은 12명의 값이 채워지면 이 분기는 자연히 전면 적용이 된다.
    let identityOk = true;
    if (user) {
      const savedName  = String((user.profile && user.profile.name)  || '').trim();
      const savedPhone = String((user.profile && user.profile.phone) || '').replace(/\D/g, '');
      if (savedName && savedPhone) {
        identityOk = (savedName === name) && (savedPhone === phone);
      }
    }

    // ★계정이 있고 «인증된» 경우에만 토큰을 만든다.
    //   EVENT_MODE 가 켜진 지금은 전원 verified:true 라 이 분기가 비어 있지만,
    //   이벤트가 끝나 off 가 되는 순간 «미인증 계정»이 생긴다. 그때 미인증 계정에
    //   재설정을 허용하면 「메일 인증 없이 계정을 여는 뒷문」이 된다.
    // ⛔여기서 실패해도 «응답을 바꾸지 않는다». 「정보가 일치하지 않습니다」를 띄우는 순간
    //   이 화면은 «이 메일의 주인이 이 이름·이 번호인지»를 맞혀 보는 도구가 된다.
    //   아래 return 은 성공·실패·미가입이 전부 똑같다.
    if (user && user.verified && identityOk) {
      const token = randomToken(32);                  // 32바이트 CSPRNG → 64 hex
      // ★★평문 토큰을 DB 에 넣지 않는다. DB 가 새면 평문 토큰은 그 자체로 계정탈취 도구다.
      //   고엔트로피(256비트) 난수라 사전공격이 성립하지 않아 salt/bcrypt 없이 sha256 이면 족하다.
      //   (기존 verificationToken 은 평문이지만 그건 존치 구조다 — 새로 짓는 것은 해시로 간다)
      const resetTokenHash = sha256hex(token);
      const resetTokenExpiresAt = new Date(now.getTime() + TOKEN_TTL_MS);

      await users.updateOne({ email }, {
        $set: { resetTokenHash, resetTokenExpiresAt, resetRequestedAt: now, updatedAt: now },
      });

      // ★2026-08-18 도메인 통일(현빈 승인) — signup.js:153 과 «같은 줄»을 쓴다.
      //   ProxyPreserveHost On 이라 라이브에서 host 는 blacksheepwall.kr 이다.
      //   vhost 는 *:80 이고 TLS 는 Cloudflare 종단이므로 https 를 하드코딩하는 게 맞다.
      const base = process.env.LICENSE_BASE_URL || `https://${req.headers.host || 'blacksheepwall.kr'}`;
      const resetUrl = `${base.replace(/\/$/, '')}/reset-password.html?token=${token}`;

      if (MAILER_LIVE) {
        await enqueueMail({
          ...buildResetMail({ to: email, resetUrl }),
          idempotencyKey: `reset:${email}:${resetTokenHash.slice(0, 16)}`,
          // ★★메일이 «자기 만료»를 들고 간다. 드레인이 늦게 돌든, 큐가 밀리든,
          //   토큰이 죽은 뒤에는 이 메일이 나가지 않는다(mail.js pendingMailFilter).
          //   「죽은 재설정 링크가 메일로 도착하는」 상황을 큐 단계에서 원천 차단한다.
          notAfter: resetTokenExpiresAt,
        });
      } else {
        // ★메일러가 없는 동안의 «전달 경로». 담당자가 이 목록을 보고 링크를 회신한다.
        //   ⛔링크·토큰은 여기에 남기지 않는다 — 남기면 이 컬렉션을 읽는 사람 누구나
        //     그 계정에 들어갈 수 있다. 링크는 scripts/issue-reset-link.mjs 로 «그때» 새로 뽑는다.
        await db.collection('reset_requests').insertOne({
          email, at: now, tokenIssued: true, handledAt: null, handledBy: null,
        });
      }
    }

    // ★★계정이 있든 없든 «완전히 동일한» 응답. (signup.js:156-159 원칙)
    //   여기서 ok:false 나 다른 reason 을 주면 위의 모든 장치가 무의미해진다.
    return settle(200, { ok: true });
  } catch (err) {
    // ⛔이메일·토큰·본문을 로그에 남기지 않는다. 재설정 링크가 저널에 평문으로 남으면
    //   그 저널을 읽을 수 있는 사람에게 계정탈취 도구를 쥐여주는 것이다.
    console.error('[reset-request] error', err && err.message);
    return settle(500, { ok: false, reason: 'internal_error' });
  }
};
