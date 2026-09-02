const { renderMail } = require('./mail-template');

const { getDb } = require('./mongo');

async function enqueueMail({ to, subject, body, html, idempotencyKey, notAfter = null }) {
  if (!to || !subject || !body || !idempotencyKey) {
    throw new Error('enqueueMail: missing required field');
  }
  const db = await getDb();
  const now = new Date();
  const doc = {
    to,
    subject,
    body,
    ...(html ? { html } : {}),
    status: 'pending',
    retryCount: 0,
    // ★«이 시각이 지나면 보내면 안 되는» 메일임을 문서 자체에 박는다(없으면 null).
    //   재설정 메일은 토큰 만료시각이 들어간다 — 링크가 죽은 뒤에 메일이 나가는 일이 원천 차단된다.
    notAfter: notAfter instanceof Date ? notAfter : null,
    idempotencyKey,
    createdAt: now,
    sentAt: null,
    lastError: null,
  };
  try {
    await db.collection('mail_queue').insertOne(doc);
    return { enqueued: true };
  } catch (err) {
    if (err && err.code === 11000) {
      return { enqueued: false, deduped: true };
    }
    throw err;
  }
}

/* ══ 드레인(메일 발송기) 안전장치 — ★발송기보다 «먼저» 존재해야 하는 코드 ══════════════
 *
 * ★왜 발송기도 없는데 지금 넣나
 *   이 조직엔 mail_queue 를 꺼내 보내는 워커가 «없다». 그래서 큐에 8~19일 묵은 메일이
 *   4통 들어 있다(2026-09-02 실측, 전부 collab 초대). 훗날 누군가 드레인을 붙이는 날,
 *   그 4통이 «방금 온 것처럼» 한꺼번에 나간다. 재설정 링크가 쌓이기 시작하면 같은 일이
 *   «죽은 계정탈취 링크»로 반복된다.
 *   ⇒ 나이 필터를 «드레인을 만드는 사람의 기억»에 맡기지 않는다. 여기서 코드로 준다.
 *     드레인은 pendingMailFilter() 를 그대로 쓰면 되고, 안 쓰면 리뷰에서 눈에 띈다.
 *
 * ★이중 방어다 — 둘 중 하나만 있어도 사고가 난다.
 *   ①notAfter : 메일 «자신»이 아는 만료(재설정 링크의 토큰 만료시각). 정확하다.
 *   ②createdAt 나이 : notAfter 가 없는 옛 메일(=지금 큐의 4통)을 위한 그물. 넓다.
 */
const MAIL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;   // 7일. 이보다 오래된 pending 은 «보내지 않는다».

/** 드레인이 «집어도 되는» 메일의 필터. ⛔드레인은 {status:'pending'} 만으로 찾지 마라. */
function pendingMailFilter(now = new Date()) {
  return {
    status: 'pending',
    // ①자기 만료를 넘긴 것 제외 (notAfter 가 없는 옛 문서는 통과시키고 ②가 잡는다)
    $or: [{ notAfter: null }, { notAfter: { $exists: false } }, { notAfter: { $gt: now } }],
    // ②너무 늙은 것 제외
    createdAt: { $gte: new Date(now.getTime() - MAIL_MAX_AGE_MS) },
  };
}

/** 「보내면 안 되는데 아직 pending 인」 메일 — status:'expired' 로 «마감»할 대상.
 *  ★pendingMailFilter 의 정확한 여집합이다. 운영자의 정리 쿼리와 드레인의 판정이
 *    갈리면 「드레인은 건너뛰는데 목록엔 계속 보이는」 유령이 생긴다. */
function staleMailFilter(now = new Date()) {
  return {
    status: 'pending',
    $or: [
      { notAfter: { $ne: null, $lte: now } },
      { createdAt: { $lt: new Date(now.getTime() - MAIL_MAX_AGE_MS) } },
    ],
  };
}

// ★모든 메일은 «HTML + 평문» 두 벌을 만든다.
//   평문은 폴백이 아니라 «필수»다 — HTML 을 못 읽는 클라이언트가 아직 있고,
//   평문만 있는 메일은 스팸 점수가 올라간다(멀티파트가 관행인 이유).
//   ⇒ 두 벌의 «내용이 달라지지 않게» 같은 함수 안에서 나란히 만든다.
function buildVerifyMail({ to, verifyUrl }) {
  const title = '이메일 인증을 완료해주세요';
  return {
    to,
    subject: '[소문의섬] ' + title,
    body: [
      '안녕하세요, 소문의섬입니다.',
      '',
      '아래 링크를 눌러 이메일 인증을 완료해주세요. 링크는 24시간 동안 유효합니다.',
      verifyUrl,
      '',
      '본인이 가입한 적이 없다면 이 메일은 무시해도 됩니다.',
    ].join('\n'),
    html: renderMail({
      label: '이메일 인증',
      title,
      paragraphs: ['안녕하세요, 소문의섬입니다.', '아래 버튼을 눌러 이메일 인증을 완료해주세요.'],
      cta: { label: '이메일 인증하기', url: verifyUrl },
      rawUrl: verifyUrl,
      notes: ['이 링크는 24시간 동안 유효합니다.',
              '본인이 가입한 적이 없다면 이 메일은 무시해도 됩니다.'],
    }),
  };
}

// ★buildVerifyMail 과 «같은 모양»으로 둔다 — 메일 본문이 파일마다 다른 틀로 흩어지면
//   문구를 고칠 때 어느 하나가 반드시 빠진다.
// ⚠️이 함수는 «본문을 만들 뿐» 보내지 않는다. 실제 큐 적재는 mailerLive 가 켜졌을 때만
//   일어난다(api/license/reset-request.js). 발송기가 없는 동안 큐에 쌓아 두면
//   훗날 가동일에 «이미 만료된» 재설정 링크가 무더기로 나간다.
function buildResetMail({ to, resetUrl }) {
  return {
    to,
    subject: '[소문의섬] 비밀번호 재설정 안내',
    html: renderMail({
      label: '비밀번호 재설정',
      title: '새 비밀번호를 정해주세요',
      paragraphs: ['안녕하세요, 소문의섬입니다.',
                   '아래 버튼을 눌러 새 비밀번호를 직접 정해주세요.'],   // ★「임시 비밀번호를 보내드리지는 않습니다」 삭제(현빈 2026-09-02)
      cta: { label: '새 비밀번호 설정하기', url: resetUrl },
      rawUrl: resetUrl,
      notes: ['이 링크는 30분 동안, 한 번만 사용할 수 있습니다.',
              '비밀번호를 바꾸면 앱과 확장 프로그램에서는 다시 로그인해야 합니다.',
              '본인이 요청한 적이 없다면 이 메일은 무시해도 됩니다. 비밀번호는 그대로 유지됩니다.'],
    }),
    body: [
      '안녕하세요, 소문의섬입니다.',
      '',
      '아래 링크를 눌러 새 비밀번호를 정해주세요.',
      resetUrl,
      '',
      '이 링크는 30분 동안, 한 번만 사용할 수 있습니다.',
      '비밀번호를 바꾸면 앱과 확장 프로그램에서는 다시 로그인해야 합니다.',
      '',
      '본인이 요청한 적이 없다면 이 메일은 무시해도 됩니다. 비밀번호는 그대로 유지됩니다.',
    ].join('\n'),
  };
}

function buildLicenseMail({ to, licenseKey }) {
  const title = '라이센스 키가 발급되었습니다';
  return {
    to,
    subject: '[소문의섬] ' + title,
    body: [
      '안녕하세요, 소문의섬입니다.',
      '',
      '아래 라이센스 키를 앱에 입력해주세요.',
      '',
      licenseKey,
      '',
      // ★2026-09-02: 여기가 'hello@example.com' 이었다 — «존재하지 않는 주소»를
      //   사용자에게 문의처로 안내하고 있었다. 실제 창구로 바꿨다.
      '문의: coq3820@gmail.com',
    ].join('\n'),
    html: renderMail({
      label: '라이센스 키',
      title,
      paragraphs: ['안녕하세요, 소문의섬입니다.', '아래 라이센스 키를 앱에 입력해주세요.'],
      notes: ['키는 본인 계정에서만 사용할 수 있습니다.'],
      code: licenseKey,
    }),
  };
}

module.exports = {
  enqueueMail, buildVerifyMail, buildResetMail, buildLicenseMail,
  pendingMailFilter, staleMailFilter, MAIL_MAX_AGE_MS,
};
