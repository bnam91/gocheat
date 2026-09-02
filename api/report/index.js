/* POST /api/report — 버그·피드백 신고 접수.
 *
 * ★익명 허용. 로그인하지 않은 사람도 보낼 수 있다.
 *   「로그인해야 신고 가능」으로 만들면 정작 «로그인이 안 된다»는 신고를 받을 수 없다.
 *
 * ★자동 전송이 아니다 (PLAN §2⑵ · 처리방침 §11 「오류 자동 전송 기능이 없다」)
 *   이 엔드포인트는 사용자가 버튼을 눌렀을 때만 호출된다. 서버는 그 약속을 «강제»할 수 없지만,
 *   앱이 지키고 이 문서가 그 계약을 적어 둔다. ⛔여기에 「주기적으로 부르는 클라이언트」를 붙이지 마라.
 *
 * ★크기 상한과 «사용자에게 보일 말» (PLAN §9 D-e)
 *   거부는 반드시 message 를 함께 준다. 「413」만 돌려주면 사용자는 무슨 일인지 모르고 다시 누른다.
 *   ⚠️상한이 세 겹이다 — 어느 겹에 걸려도 말이 나가야 한다:
 *     ①ec2-server 4.5MB(어댑터, 핸들러 진입 전)  ②여기 3.8MB(본문 바이트)  ③이미지 개별/합계
 *   ②를 ①보다 «낮게» 둔 이유: 그래야 우리 말이 먼저 나간다. ①은 최후의 그물이다.
 */
const crypto = require('crypto');
const { ObjectId } = require('mongodb');
const { getDb } = require('../_lib/mongo');
const { json } = require('../_lib/util');
const { readJsonBodyLimited, handlePreflightAuth, setCorsAuth, clientIp } = require('../_lib/http-extra');
const { findUserBySession } = require('../_lib/roles');
const { decodeImage, saveImages } = require('../_lib/report-store');

const LIMITS = {
  BODY_BYTES: 3_800_000,      // ec2-server 의 4.5MB 보다 «낮게» — 우리 메시지가 먼저 나가게
  TEXT: 5000,
  IMAGES: 4,
  IMAGE_BYTES: 2_000_000,     // 디코드 후 한 장
  IMAGES_TOTAL_BYTES: 3_000_000,
  ERRORS: 20,                 // 링버퍼 크기와 같다(앱: 최근 20건)
  ERROR_LEN: 1000,
  FIELD: 200,                 // appVersion/os/arch/screen/projectId 같은 짧은 값
  RATE_PER_HOUR: 10,          // 익명 공개 쓰기라 남용 방지가 필요하다
};

const TYPES = ['bug', 'idea', 'etc'];

/* ★경로 세척 — 앱이 «담을 때» 씻지만(PLAN §7⑵), 서버도 한 번 더 씻는다.
 *   구버전 앱, 큐에 오래 남아 있던 신고, 직접 친 요청은 안 씻긴 채로 온다.
 *   ⛔사용자가 «직접 쓴» text 는 건드리지 않는다 — 「/Users/… 에서 안 열려요」를 뭉개면
 *     정작 재현 정보가 사라진다. 씻는 대상은 자동으로 붙는 errors[] 뿐이다. */
function scrubPaths(s) {
  return String(s)
    .replace(/\/Users\/[^/\s'")\]]+/g, '/Users/~')
    .replace(/\/home\/[^/\s'")\]]+/g, '/home/~')
    .replace(/([A-Za-z]:\\Users\\)[^\\\s'")\]]+/g, '$1~');
}

function clip(v, n) {
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  return s ? s.slice(0, n) : undefined;
}

/** 요청 본문 → 저장할 모양. ⛔여기서 던지지 않는다. 거부 사유는 reject 로 «말과 함께» 돌려준다.
 *  (테스트가 이 함수를 그대로 부른다 — 순수 함수로 둔다) */
function normalizeReport(body) {
  const type = TYPES.includes(String(body.type || '').toLowerCase())
    ? String(body.type).toLowerCase() : 'etc';

  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) {
    return { reject: { status: 400, error: 'empty_text', message: '내용을 적어 주세요.' } };
  }
  if (text.length > LIMITS.TEXT) {
    return { reject: { status: 400, error: 'text_too_long',
      message: `내용이 너무 깁니다. ${LIMITS.TEXT}자 이내로 줄여 주세요. (지금 ${text.length}자)` } };
  }

  const errorsIn = Array.isArray(body.errors) ? body.errors.slice(-LIMITS.ERRORS) : [];
  const errors = errorsIn.map((e) => {
    const raw = (e && typeof e === 'object')
      ? { at: clip(e.at, 40), level: clip(e.level, 20), msg: e.msg !== undefined ? e.msg : e.message }
      : { msg: e };
    return {
      at: raw.at,
      level: raw.level,
      // ★세척은 «자르기 전»에 — 잘라놓고 씻으면 반쯤 잘린 경로가 정규식을 빠져나간다.
      msg: scrubPaths(raw.msg === undefined ? '' : (typeof raw.msg === 'string' ? raw.msg : JSON.stringify(raw.msg)))
        .slice(0, LIMITS.ERROR_LEN),
    };
  }).filter((e) => e.msg);

  /* ★이미지 «키 자체»의 유무를 보존한다 (PLAN §9 C-c)
   *   캡처 끔이면 앱은 images 키를 «아예 안 보낸다». 빈 배열도 아니다.
   *   그 사실을 hasImagesKey 로 기록해 두면, 나중에 「캡처 껐는데 왜 있지」를 판정할 수 있다. */
  const hasImagesKey = Object.prototype.hasOwnProperty.call(body, 'images');
  const rawImages = Array.isArray(body.images) ? body.images : [];
  if (rawImages.length > LIMITS.IMAGES) {
    return { reject: { status: 400, error: 'too_many_images',
      message: `이미지는 최대 ${LIMITS.IMAGES}장까지 보낼 수 있습니다.` } };
  }

  const images = [];
  let total = 0;
  for (const it of rawImages) {
    const dec = decodeImage(it);
    if (!dec) {
      return { reject: { status: 400, error: 'bad_image',
        message: '이미지 형식을 읽을 수 없습니다. PNG·JPG·WEBP 만 보낼 수 있습니다.' } };
    }
    if (dec.buf.length > LIMITS.IMAGE_BYTES) {
      return { reject: { status: 413, error: 'image_too_large',
        message: `이미지 한 장이 너무 큽니다(${Math.round(dec.buf.length / 1024)}KB). `
          + `${Math.round(LIMITS.IMAGE_BYTES / 1024)}KB 이하로 줄이거나 캡처를 끄고 보내 주세요.` } };
    }
    total += dec.buf.length;
    if (total > LIMITS.IMAGES_TOTAL_BYTES) {
      return { reject: { status: 413, error: 'images_too_large',
        message: `이미지 전체 용량이 너무 큽니다. 합쳐서 ${Math.round(LIMITS.IMAGES_TOTAL_BYTES / 1024 / 1024)}MB 이하로 보내 주세요.` } };
    }
    images.push({ kind: it.kind === 'capture' ? 'capture' : 'attach', name: it.name, __decoded: dec });
  }

  return {
    doc: {
      type,
      text,
      appVersion: clip(body.appVersion, LIMITS.FIELD),
      os: clip(body.os, LIMITS.FIELD),
      arch: clip(body.arch, LIMITS.FIELD),
      screen: clip(body.screen, LIMITS.FIELD),
      projectId: clip(body.projectId, LIMITS.FIELD),
      app: clip(body.app, 40) || 'goditor',
      errors,
      hasImagesKey,
    },
    images,
  };
}

/** 같은 오류의 반복 신고를 «묶어 세기» 위한 지문. ⛔거부하는 데 쓰지 마라 —
 *  거부하면 사용자는 「안 보내졌나」 하고 또 누른다(PLAN §7⑶). */
function fingerprint(doc) {
  const head = (doc.errors[0] && doc.errors[0].msg) || doc.text.slice(0, 120);
  return crypto.createHash('sha256')
    .update(`${doc.type}|${String(head).replace(/\d+/g, '#')}`, 'utf8')
    .digest('hex').slice(0, 16);
}

module.exports = async (req, res) => {
  if (handlePreflightAuth(req, res, 'POST, OPTIONS')) return;
  setCorsAuth(res, 'POST, OPTIONS');
  if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method_not_allowed' });

  let body;
  try {
    body = await readJsonBodyLimited(req, LIMITS.BODY_BYTES);
  } catch (err) {
    if (err.tooLarge) {
      // ★D-e — 여기가 「캡처 켠 채 캔버스가 아주 큼」이 도착하는 자리다. 반드시 «말»을 붙인다.
      return json(res, 413, {
        ok: false, error: 'payload_too_large',
        message: '보낼 내용이 너무 큽니다. 캡처를 끄거나 첨부 이미지를 줄이고 다시 보내 주세요.',
        limitBytes: LIMITS.BODY_BYTES,
      });
    }
    return json(res, 400, { ok: false, error: 'invalid_body', message: '요청 형식이 올바르지 않습니다.' });
  }

  const norm = normalizeReport(body);
  if (norm.reject) {
    return json(res, norm.reject.status, { ok: false, error: norm.reject.error, message: norm.reject.message });
  }

  try {
    const db = await getDb();

    /* ★남용 방지 — 익명 «공개 쓰기»다. 인증이 없으니 다른 축으로 막아야 한다.
     *   IP 원문은 저장하지 않는다(해시만). 창을 넘으면 429 + 말. */
    const ipHash = crypto.createHash('sha256')
      .update(`report|${clientIp(req)}`, 'utf8').digest('hex').slice(0, 24);
    const since = new Date(Date.now() - 3600_000);
    const recent = await db.collection('report_attempts').countDocuments({ key: ipHash, at: { $gte: since } });
    if (recent >= LIMITS.RATE_PER_HOUR) {
      return json(res, 429, {
        ok: false, error: 'rate_limited',
        message: '신고가 너무 자주 접수되었습니다. 잠시 후 다시 시도해 주세요.',
      });
    }

    /* ★로그인 여부는 «토큰»으로 확인한다. 사용자가 입력창에 친 이메일은 사칭이 가능하다.
     *   ⇒ accountEmail(토큰으로 확인됨) 과 email(사용자가 적음) 을 «다른 칸»에 둔다.
     *   D-c(로그아웃 직후 신고): 토큰이 죽었으면 user 가 null → accountEmail 없음 = 익명. 이전 계정이 새지 않는다. */
    let accountEmail = null;
    let plan = null;
    if (typeof body.sessionToken === 'string' && body.sessionToken.trim()) {
      const user = await findUserBySession(db, body.sessionToken);
      if (user) { accountEmail = user.email; plan = user.plan || null; }
    }

    const _id = new ObjectId();
    const doc = {
      _id,
      ...norm.doc,
      email: clip(body.email, 254) || null,   // 사용자가 적은 회신처(미검증)
      accountEmail,                            // 세션토큰으로 «확인된» 계정 (없으면 익명)
      plan,
      images: [],                              // ★본문 먼저 넣고 이미지는 뒤에 붙인다(아래 이유)
      status: 'new',                           // new | read | done — 어드민이 읽는 축
      fingerprint: fingerprint(norm.doc),
      ipHash,
      createdAt: new Date(),
    };
    delete doc.hasImagesKey;
    doc.capture = { requested: norm.doc.hasImagesKey, count: norm.images.length };

    /* ★순서가 곧 정책이다 — 본문 저장이 «먼저».
     *   이미지 쓰기가 실패해도(디스크 잠김·가득 참) 신고는 남는다. 반대로 하면
     *   「보냈습니다」라고 말해놓고 아무것도 안 남는 최악(PLAN §2⑸)이 된다. */
    await db.collection('reports').insertOne(doc);
    await db.collection('report_attempts').insertOne({ key: ipHash, at: new Date() });

    let warning = null;
    let imagesSaved = 0;
    if (norm.images.length) {
      const saved = await saveImages(_id.toHexString(), norm.images);
      imagesSaved = saved.saved.length;
      if (imagesSaved) {
        await db.collection('reports').updateOne({ _id }, { $set: { images: saved.saved } });
      }
      if (saved.failed) {
        await db.collection('reports').updateOne({ _id },
          { $set: { imageError: { failed: saved.failed, reason: saved.reason } } });
        // ⛔실패를 조용히 넘기지 마라 — 사용자는 캡처가 갔다고 믿는다.
        warning = '내용은 접수되었지만 이미지는 저장하지 못했습니다.';
      }
    }

    return json(res, 200, {
      ok: true,
      reportId: _id.toHexString(),
      imagesSaved,
      message: warning || '접수되었습니다. 확인 후 반영하겠습니다.',
      ...(warning ? { warning } : {}),
    });
  } catch (err) {
    console.error('[report] error', err && err.message);
    return json(res, 500, { ok: false, error: 'internal_error', message: '지금은 보낼 수 없습니다. 잠시 후 다시 시도해 주세요.' });
  }
};

module.exports.LIMITS = LIMITS;
module.exports.normalizeReport = normalizeReport;
module.exports.scrubPaths = scrubPaths;
module.exports.fingerprint = fingerprint;
