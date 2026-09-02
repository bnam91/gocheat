/* POST /api/report/list — 어드민이 «받은 신고를 읽는» 길.  (PLAN §9 B-b)
 *
 * ★왜 이게 3개 밖에 있는데도 필요한가
 *   PLAN B-b: 「어드민이 받은 신고를 읽는 길 — 이게 없으면 기능 전체가 무의미」.
 *   신고가 DB 에 쌓이기만 하고 아무도 안 보면 사용자는 «허공에» 말한 것이 된다(§5 위험표).
 *
 * ★왜 GET 이 아니라 POST 인가
 *   세션토큰을 쿼리스트링에 실으면 nginx 액세스로그에 남는다 — 로그가 곧 열쇠꾸러미가 된다.
 *   ec2-server 는 본문을 로그하지 않는다(그 파일 주석 «⛔바디를 로그에 남기지 않는다»).
 *   ⇒ 조회지만 본문으로 받는다. 부작용은 없다(읽기 전용, status 변경은 op 로 명시할 때만).
 *
 * 입력  { sessionToken, limit?, before?(ISO), type?, status?, op?:'read'|'status' }
 */
const { ObjectId } = require('mongodb');
const { getDb } = require('../_lib/mongo');
const { json } = require('../_lib/util');
const { readJsonBodyLimited, handlePreflightAuth, setCorsAuth } = require('../_lib/http-extra');
const { requireAdmin } = require('../_lib/roles');

const STATUSES = ['new', 'read', 'done'];

module.exports = async (req, res) => {
  if (handlePreflightAuth(req, res, 'POST, OPTIONS')) return;
  setCorsAuth(res, 'POST, OPTIONS');
  if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method_not_allowed' });

  let body;
  try { body = await readJsonBodyLimited(req, 16 * 1024); }
  catch { return json(res, 400, { ok: false, error: 'invalid_body' }); }

  try {
    const db = await getDb();
    const gate = await requireAdmin(db, body.sessionToken);
    if (!gate.ok) return json(res, gate.status, { ok: false, error: gate.error, message: gate.message });

    if (String(body.op || '') === 'status') {
      if (!/^[0-9a-f]{24}$/i.test(String(body.reportId || ''))) {
        return json(res, 400, { ok: false, error: 'bad_id' });
      }
      const status = STATUSES.includes(String(body.status || '')) ? String(body.status) : null;
      if (!status) return json(res, 400, { ok: false, error: 'bad_status' });
      const r = await db.collection('reports').updateOne(
        { _id: new ObjectId(String(body.reportId)) },
        { $set: { status, statusAt: new Date(), statusBy: gate.user.email } },
      );
      if (!r.matchedCount) return json(res, 404, { ok: false, error: 'not_found' });
      return json(res, 200, { ok: true, status });
    }

    const limit = Math.min(Math.max(parseInt(body.limit, 10) || 30, 1), 100);
    const q = {};
    if (body.type) q.type = String(body.type);
    if (body.status) q.status = String(body.status);
    if (body.before) {
      const d = new Date(body.before);
      if (!Number.isNaN(d.getTime())) q.createdAt = { $lt: d };
    }

    const rows = await db.collection('reports')
      .find(q).sort({ createdAt: -1 }).limit(limit).toArray();

    return json(res, 200, {
      ok: true,
      reports: rows.map((r) => ({
        id: String(r._id),
        type: r.type,
        text: r.text,
        email: r.email,
        accountEmail: r.accountEmail,
        plan: r.plan,
        appVersion: r.appVersion,
        os: r.os,
        arch: r.arch,
        screen: r.screen,
        projectId: r.projectId,
        app: r.app,
        errors: r.errors,
        // ★이미지는 «경로»만 준다. 바이트는 /api/report/image 로 한 장씩 — 목록이 수십 MB 가 되면 아무도 안 연다.
        images: (r.images || []).map((im, i) => ({ i, kind: im.kind, mime: im.mime, bytes: im.bytes, name: im.name })),
        imageError: r.imageError || null,
        capture: r.capture,
        fingerprint: r.fingerprint,
        status: r.status,
        createdAt: r.createdAt,
      })),
      // 다음 쪽 커서 — 마지막 행의 createdAt 을 before 로 다시 준다.
      nextBefore: rows.length === limit ? rows[rows.length - 1].createdAt : null,
    });
  } catch (err) {
    console.error('[report/list] error', err && err.message);
    return json(res, 500, { ok: false, error: 'internal_error' });
  }
};
