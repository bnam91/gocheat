const { getDb } = require('../_lib/mongo');
const {
  json, handlePreflight, readJsonBody, isValidEmail, normalizeEmail,
} = require('../_lib/util');
const {
  newId, authenticate, unauthorized, notFound, loadProject,
} = require('../_lib/collab');
const { enqueueMail } = require('../_lib/mail');

/* 협업 초대 만들기.
 *
 * 입력  { sessionToken, collabId, email }
 * 출력  { ok, inviteId, mailed }
 *
 * ★메일은 «곁가지»다. 정본 전달 경로는 앱의 폴링(POST /api/collab/invites)이다.
 *   이 조직엔 아직 메일 «발송기»가 없다 — _lib/mail.js 는 mail_queue 에 넣기만 하고,
 *   그걸 실제로 보내는 워커가 없다. 그래서 메일을 전제로 설계하면 초대가 «도달하지 않는다».
 *   큐에는 넣어둔다(나중에 발송기가 붙으면 그날부터 저절로 나간다). 하지만 메일이
 *   한 통도 안 나가도 초대는 상대 앱 화면에 뜬다 — 그게 이 설계의 요점이다.
 *   ⇒ 큐 삽입이 실패해도 초대는 «성공»으로 돌려준다. 곁가지가 본체를 넘어뜨리면 안 된다.
 */
module.exports = async (req, res) => {
  if (handlePreflight(req, res, { origin: '*' })) return;
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });
  res.setHeader('Access-Control-Allow-Origin', '*');

  let body;
  try { body = await readJsonBody(req); }
  catch (err) { return json(res, 400, { error: 'invalid_body', detail: err.message }); }

  const invitee = normalizeEmail(body.email);
  if (!isValidEmail(invitee)) return json(res, 400, { ok: false, reason: 'invalid_email' });

  try {
    const db = await getDb();
    const user = await authenticate(db, body.sessionToken);
    if (!user) return unauthorized(res);

    // ★멤버면 누구나 초대할 수 있다(소유자 전용이 아니다). 대신 «멤버가 아니면 404».
    const project = await loadProject(db, body.collabId, user.email);
    if (!project) return notFound(res);

    if (invitee === user.email) return json(res, 400, { ok: false, reason: 'cannot_invite_self' });
    if (project.members.includes(invitee)) {
      return json(res, 409, { ok: false, reason: 'already_member' });
    }

    const invites = db.collection('collab_invites');
    // 중복 초대 방어 — 같은 사람에게 pending 이 이미 있으면 그걸 돌려준다(멱등).
    const pending = await invites.findOne({
      collabId: project.collabId, email: invitee, status: 'pending',
    });
    if (pending) {
      return json(res, 200, { ok: true, inviteId: pending.inviteId, duplicated: true, mailed: false });
    }

    const inviteId = newId('iv');
    await invites.insertOne({
      inviteId,
      collabId: project.collabId,
      projectName: project.name,
      email: invitee,               // 받는 사람
      invitedBy: user.email,
      status: 'pending',
      createdAt: new Date(),
      respondedAt: null,
    });

    // 곁가지: 메일 큐. 실패해도 초대는 이미 섰다.
    let mailed = false;
    try {
      const r = await enqueueMail({
        to: invitee,
        subject: '[소문의섬] GODITOR 공동작업에 초대되었습니다',
        body: [
          '안녕하세요, 소문의섬입니다.',
          '',
          `${user.email} 님이 GODITOR 프로젝트 「${project.name}」 공동작업에 초대했습니다.`,
          '',
          'GODITOR 앱에 로그인하면 상단에 초대 알림이 뜹니다. 거기서 수락해주세요.',
          '',
          '초대한 적이 없는 분이라면 이 메일은 무시해도 됩니다.',
        ].join('\n'),
        idempotencyKey: `collab_invite:${inviteId}`,
      });
      mailed = !!r.enqueued;
    } catch (err) {
      console.error('[collab/invite] mail enqueue failed (초대는 유효하다)', err);
    }

    return json(res, 200, { ok: true, inviteId, duplicated: false, mailed });
  } catch (err) {
    console.error('[collab/invite] error', err);
    return json(res, 500, { ok: false, reason: 'internal_error' });
  }
};
