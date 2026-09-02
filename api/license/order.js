const { getDb } = require('../_lib/mongo');
const { enqueueMail } = require('../_lib/mail');
const { json, handlePreflight, readJsonBody, isValidEmail, normalizeEmail } = require('../_lib/util');

// ★data/apps.json 의 유료 등급 id 와 «같아야» 한다. 갈리면 주문이 400 으로 튕긴다.
const PLANS = ['intern', 'pro', 'pro12', 'pro_training'];
const BANK = process.env.BANK_INFO || '국민은행 000000-00-000000 (예금주: 신현빈)';

// 무통장입금 구매 신청. 결제 확인은 사람이 한다 — 여기서는 주문만 남기고 안내 메일 1통.
module.exports = async (req, res) => {
  if (handlePreflight(req, res, { origin: '*' })) return;
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });

  let body;
  try { body = await readJsonBody(req); }
  catch (err) { return json(res, 400, { error: 'invalid_body', detail: err.message }); }

  const email = normalizeEmail(body.email);
  const plan = String(body.plan || '').toLowerCase();
  const depositor = String(body.depositor || '').trim();   // ★입금자명 — 통장 대조의 유일한 단서

  if (!isValidEmail(email)) return json(res, 400, { error: 'invalid_email' });
  if (!PLANS.includes(plan)) return json(res, 400, { error: 'invalid_plan', detail: PLANS.join('/') });
  if (!depositor) return json(res, 400, { error: 'depositor_required', detail: '입금자명을 입력해 주세요' });

  try {
    const db = await getDb();
    const user = await db.collection('users').findOne({ email });
    if (!user) return json(res, 404, { error: 'account_not_found', detail: '먼저 가입해 주세요' });

    const now = new Date();
    const orderNo = 'GD' + now.toISOString().slice(2, 10).replace(/-/g, '') + '-' +
      String(await db.collection('orders').estimatedDocumentCount() + 1).padStart(4, '0');

    await db.collection('orders').insertOne({
      orderNo, email, plan, depositor,
      status: 'awaiting_deposit',     // → 사람이 확인 후 'paid'
      createdAt: now, confirmedAt: null,
    });

    await enqueueMail({
      to: email,
      subject: '[소문의섬] 무통장입금 안내 · 주문 ' + orderNo,
      body: [
        '구매 신청이 접수되었습니다.',
        '',
        `주문번호 : ${orderNo}`,
        `상품     : ${plan}`,
        `입금자명 : ${depositor}`,
        '',
        `입금 계좌 : ${BANK}`,
        '',
        '입금이 확인되면 계정에 바로 반영됩니다. (보통 1영업일 이내)',
        '입금자명이 다르면 확인이 늦어질 수 있습니다.',
      ].join('\n'),
      idempotencyKey: `order:${orderNo}`,
    });

    return json(res, 200, { ok: true, orderNo, plan, depositor, bank: BANK, status: 'awaiting_deposit' });
  } catch (err) {
    console.error('[order] error', err);
    return json(res, 500, { error: 'internal_error' });
  }
};
