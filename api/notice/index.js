/* POST /api/notice — 공지 작성 · 목록 · 회수.  ★★이 유닛의 보안 핵심.
 *
 * ★왜 서버가 막아야 하나 (PLAN §2⑷)
 *   이 엔드포인트를 통과하면 «전체 사용자의 화면에 모달을 띄울 수 있다». 화면에서 탭을 감추는 건
 *   보안이 아니다 — curl 한 줄이면 지나간다. 권한은 여기서, 세션토큰이 가리키는 계정의 role 로 지킨다.
 *
 * ★판정은 «DB 의 지금 값»이다(_lib/roles.js).
 *   ⇒ 로그아웃하면 토큰이 죽어 그 즉시 401 이다(PLAN §9 D-d). 앱이 role 을 캐시해 둬도 소용없다.
 *
 * ⛔클라이언트가 보낸 role·isAdmin 같은 필드는 «읽지도» 마라. 읽는 순간 언젠가 그걸 믿는 코드가 생긴다.
 *
 * 입력  { sessionToken, op?, ... }
 *   op 없음 | 'create' → 작성      { title, body, level, target, startAt?, endAt }
 *   op='list'          → 최근 목록 (미리보기·회수 대상 고르기용, PLAN B-c/B-d)
 *   op='revoke'        → 회수      { noticeId }
 */
const { ObjectId } = require('mongodb');
const { getDb } = require('../_lib/mongo');
const { json } = require('../_lib/util');
const { readJsonBodyLimited, handlePreflightAuth, setCorsAuth } = require('../_lib/http-extra');
const { requireAdmin } = require('../_lib/roles');
const { validateCreate } = require('../_lib/notice-lib');

const BODY_LIMIT = 64 * 1024;    // 공지는 글이다. 이보다 클 이유가 없다.

module.exports = async (req, res) => {
  if (handlePreflightAuth(req, res, 'POST, OPTIONS')) return;
  setCorsAuth(res, 'POST, OPTIONS');
  if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method_not_allowed' });

  let body;
  try {
    body = await readJsonBodyLimited(req, BODY_LIMIT);
  } catch (err) {
    if (err.tooLarge) {
      return json(res, 413, { ok: false, error: 'payload_too_large', message: '공지 내용이 너무 깁니다.' });
    }
    return json(res, 400, { ok: false, error: 'invalid_body', message: '요청 형식이 올바르지 않습니다.' });
  }

  try {
    const db = await getDb();

    /* ★★게이트 — 아래 어떤 분기보다 «먼저». 읽기(list)도 어드민만이다.
     *   공지 목록엔 아직 시작 안 한 공지·회수한 공지가 들어 있다(운영 정보). */
    const gate = await requireAdmin(db, body.sessionToken);
    if (!gate.ok) {
      // 이 경로에서만 말을 구체화한다(게이트 자체는 일반 문구를 준다).
      const message = gate.error === 'forbidden' ? '공지를 보낼 권한이 없습니다.' : gate.message;
      return json(res, gate.status, { ok: false, error: gate.error, message });
    }

    const op = String(body.op || 'create').toLowerCase();

    if (op === 'list') {
      const rows = await db.collection('notices')
        .find({}).sort({ createdAt: -1 }).limit(50).toArray();
      return json(res, 200, {
        ok: true,
        notices: rows.map((n) => ({
          id: String(n._id),
          title: n.title,
          body: n.body,
          level: n.level,
          target: n.target,
          startAt: n.startAt,
          endAt: n.endAt,
          revoked: !!n.revoked,
          createdBy: n.createdBy,
          createdAt: n.createdAt,
        })),
        serverNow: new Date().toISOString(),
      });
    }

    if (op === 'revoke') {
      // ★잘못 보낸 공지를 «즉시» 멈추는 길(PLAN B-d). 지우지 않고 표시만 한다 — 무엇을 보냈는지 남아야 한다.
      if (!/^[0-9a-f]{24}$/i.test(String(body.noticeId || ''))) {
        return json(res, 400, { ok: false, error: 'bad_id', message: '공지를 고르세요.' });
      }
      const r = await db.collection('notices').updateOne(
        { _id: new ObjectId(String(body.noticeId)) },
        { $set: { revoked: true, revokedAt: new Date(), revokedBy: gate.user.email } },
      );
      if (!r.matchedCount) return json(res, 404, { ok: false, error: 'not_found', message: '그런 공지가 없습니다.' });
      return json(res, 200, { ok: true, revoked: true, message: '공지를 회수했습니다. 이제 새로 뜨지 않습니다.' });
    }

    if (op !== 'create') {
      return json(res, 400, { ok: false, error: 'bad_op', message: '알 수 없는 요청입니다.' });
    }

    const v = validateCreate(body, Date.now());
    if (v.error) return json(res, 400, { ok: false, error: v.error, message: v.message });

    const doc = {
      ...v.doc,
      revoked: false,
      createdBy: gate.user.email,      // ★누가 보냈는지 «반드시» 남는다. 익명 발송은 없다.
      createdAt: new Date(),
    };
    const r = await db.collection('notices').insertOne(doc);

    return json(res, 200, {
      ok: true,
      noticeId: String(r.insertedId),
      notice: { id: String(r.insertedId), title: doc.title, body: doc.body, level: doc.level,
                target: doc.target, startAt: doc.startAt, endAt: doc.endAt },
      message: '공지를 등록했습니다.',
    });
  } catch (err) {
    console.error('[notice] error', err && err.message);
    return json(res, 500, { ok: false, error: 'internal_error', message: '지금은 등록할 수 없습니다.' });
  }
};
