/* GET /api/report/image?id=<reportId>&i=<번호> — 신고에 붙은 캡처/첨부를 «어드민만» 꺼낸다.
 *
 * ★★이 파일이 「docroot 밖 저장」의 나머지 반쪽이다.
 *   파일을 웹루트 밖에 둬도 «인증 없는 꺼내는 문»을 내면 같은 사고다(2026-09-02 백업 93개 공개 건).
 *   ⇒ 여기서 role 을 검사한다. 통과 못 하면 바이트를 «한 개도» 내보내지 않는다.
 *
 * ★토큰은 헤더로 받는다 (Authorization: Bearer … 또는 x-session-token)
 *   <img src> 로는 헤더를 못 붙이므로, 어드민 화면은 fetch 로 받아 blob URL 을 만들어 쓴다.
 *   ⛔쿼리스트링 토큰으로 바꾸지 마라 — 액세스로그에 남고, 그 로그를 보는 사람이 곧 어드민이 된다.
 *
 * ★경로는 «DB 에 적힌 것»만 쓴다. 요청의 문자열을 경로에 붙이지 않는다(디렉터리 탈출 차단).
 */
const { ObjectId } = require('mongodb');
const { getDb } = require('../_lib/mongo');
const { json } = require('../_lib/util');
const { getQuery, handlePreflightAuth, setCorsAuth, sessionTokenFromHeader } = require('../_lib/http-extra');
const { requireAdmin } = require('../_lib/roles');
const { readStored } = require('../_lib/report-store');

module.exports = async (req, res) => {
  if (handlePreflightAuth(req, res, 'GET, OPTIONS')) return;
  setCorsAuth(res, 'GET, OPTIONS');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method_not_allowed', message: '잘못된 요청입니다.' });

  const q = getQuery(req);
  const id = String(q.id || '');
  const idx = parseInt(q.i, 10);
  if (!/^[0-9a-f]{24}$/i.test(id) || !Number.isInteger(idx) || idx < 0) {
    return json(res, 400, { ok: false, error: 'bad_request', message: '이미지를 고르세요.' });
  }

  try {
    const db = await getDb();
    const gate = await requireAdmin(db, sessionTokenFromHeader(req));
    if (!gate.ok) return json(res, gate.status, { ok: false, error: gate.error, message: gate.message });

    const doc = await db.collection('reports').findOne(
      { _id: new ObjectId(id) }, { projection: { images: 1 } });
    const im = doc && Array.isArray(doc.images) ? doc.images[idx] : null;
    // ★404 에 message 필수 — 「경로 미배포」와 구분하는 근거다(G4 합의).
    if (!im) return json(res, 404, { ok: false, error: 'not_found', message: '그런 이미지가 없습니다.' });

    const file = await readStored(im.path);
    if (!file) return json(res, 404, { ok: false, error: 'file_missing', message: '이미지 파일을 찾을 수 없습니다(서버에서 지워졌을 수 있습니다).' });

    res.statusCode = 200;
    res.setHeader('Content-Type', im.mime || 'application/octet-stream');
    res.setHeader('Content-Length', String(file.buf.length));
    // ⛔브라우저가 «페이지처럼» 열지 못하게 — 신고 이미지는 남의 자료다.
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.end(file.buf);
  } catch (err) {
    console.error('[report/image] error', err && err.message);
    return json(res, 500, { ok: false, error: 'internal_error', message: '이미지를 불러오지 못했습니다.' });
  }
};
