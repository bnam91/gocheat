const { getDb } = require('./mongo');

async function enqueueMail({ to, subject, body, html, idempotencyKey }) {
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

function buildVerifyMail({ to, verifyUrl }) {
  return {
    to,
    subject: '[소문의섬] 이메일 인증을 완료해주세요',
    body: [
      '안녕하세요, 소문의섬입니다.',
      '',
      '아래 링크를 눌러 이메일 인증을 완료해주세요. 링크는 24시간 동안 유효합니다.',
      verifyUrl,
      '',
      '본인이 가입한 적이 없다면 이 메일은 무시해도 됩니다.',
    ].join('\n'),
  };
}

function buildLicenseMail({ to, licenseKey }) {
  return {
    to,
    subject: '[소문의섬] 라이센스 키가 발급되었습니다',
    body: [
      '안녕하세요, 소문의섬입니다.',
      '',
      '아래 라이센스 키를 앱에 입력해주세요.',
      '',
      licenseKey,
      '',
      '문의: hello@example.com',
    ].join('\n'),
  };
}

module.exports = { enqueueMail, buildVerifyMail, buildLicenseMail };
