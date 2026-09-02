/* 신고 첨부 이미지의 «디스크» 저장소.
 *
 * ★왜 DB 가 아니라 파일인가
 *   캡처 한 장이 70KB, 사용자 첨부는 MB 단위다. Mongo 문서에 base64 로 넣으면 문서가 16MB 상한에
 *   부딪히고, 목록 조회가 이미지까지 끌고 온다. DB 엔 «경로»만 둔다.
 *
 * ★★왜 docroot 밖인가 (2026-09-02 실사고)
 *   같은 날 백업 파일 93개가 웹루트에 있어 «주소만 알면 누구나» 받아갈 수 있는 상태였다.
 *   신고 캡처에는 고객사 상세페이지가 통째로 들어 있다 — 유출되면 우리 잘못이 아니라 «남의 기획»이 샌다.
 *   ⇒ 저장 루트는 라이브 웹루트(/opt/goditor-api)와 «겹치지 않는» 곳이어야 한다.
 *     기본값 /var/lib/goditor-api/report-uploads. 꺼내는 길은 어드민 전용 엔드포인트 하나뿐이다.
 *
 * ⚠️★systemd 제약 (이걸 모르면 라이브에서 조용히 실패한다)
 *   goditor-api.service 는 ProtectSystem=strict + ReadWritePaths=(빈 값) 이다 —
 *   「앱은 로컬 파일을 쓰지 않는다」는 전제로 잠가 뒀다. 지금 상태로는 이 디렉터리에 «한 바이트도» 못 쓴다.
 *   ⇒ 유닛에 StateDirectory=goditor-api 를 넣어야 열린다(보고서의 드롭인 패치 참조).
 *     그 패치 «전»에는 이 모듈이 실패하지만, 신고 본문은 그래도 저장된다(아래 설계).
 *
 * ★설계 원칙 — 「이미지 때문에 신고를 잃지 않는다」(PLAN §2⑸)
 *   본문 저장이 먼저, 이미지는 나중. 이미지 쓰기가 실패해도 신고는 남고 사용자에게 그 사실을 말한다.
 */
const fs = require('fs');
const path = require('path');

const ROOT = process.env.REPORT_UPLOAD_DIR || '/var/lib/goditor-api/report-uploads';

// 허용 형식 — 이 셋 밖은 받지 않는다. ⛔svg 금지(스크립트를 품는다), ⛔gif 금지(필요 없다).
const MIME_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

// 디스크가 이만큼도 안 남았으면 이미지를 아예 받지 않는다. 서버를 채워 죽이는 게 최악이다.
const MIN_FREE_BYTES = 1024 * 1024 * 1024;   // 1GB

/** 'data:image/png;base64,AAAA' 또는 순수 base64 → { mime, buf } | null */
function decodeImage(entry) {
  if (!entry) return null;
  let mime = typeof entry.mime === 'string' ? entry.mime.trim().toLowerCase() : '';
  let b64 = typeof entry.data === 'string' ? entry.data : '';
  const m = b64.match(/^data:([a-z0-9.+/-]+);base64,(.*)$/is);
  if (m) { mime = mime || m[1].toLowerCase(); b64 = m[2]; }
  if (!MIME_EXT[mime]) return null;
  b64 = b64.replace(/\s+/g, '');
  if (!b64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return null;
  let buf;
  try { buf = Buffer.from(b64, 'base64'); } catch { return null; }
  if (!buf.length) return null;
  // ★매직바이트 대조 — 확장자·mime 은 «클라이언트가 하는 말»이다. 실제 바이트가 그 형식인지 본다.
  if (!looksLike(mime, buf)) return null;
  return { mime, buf };
}

function looksLike(mime, buf) {
  if (mime === 'image/png') return buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47;
  if (mime === 'image/jpeg') return buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8;
  if (mime === 'image/webp') return buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP';
  return false;
}

/** 여유 공간 확인. statfs 를 못 쓰는 런타임이면 «통과»시킨다(가드 없음을 실패로 만들지 않는다). */
async function hasFreeSpace(dir) {
  try {
    if (!fs.promises.statfs) return true;
    const s = await fs.promises.statfs(dir);
    return (s.bavail * s.bsize) > MIN_FREE_BYTES;
  } catch { return true; }
}

/** reportId 는 우리가 만든 24자 hex 뿐이다. ⛔이 검사 없이 경로에 붙이면 ../ 로 어디든 읽힌다. */
function safeId(id) {
  return /^[0-9a-f]{24}$/.test(String(id || '')) ? String(id) : null;
}

/** '2026-09/<id>/0.png' 같은 상대경로만 받는다. 절대경로·상위이동은 거부. */
function resolveStored(relPath) {
  const rel = String(relPath || '');
  if (!/^[0-9]{4}-[0-9]{2}\/[0-9a-f]{24}\/[0-9]+\.(png|jpg|webp)$/.test(rel)) return null;
  const abs = path.resolve(ROOT, rel);
  // ★이중 방어 — 정규식을 통과해도 실제 해석 결과가 루트 밖이면 거부한다.
  if (abs !== path.normalize(abs) || !abs.startsWith(path.resolve(ROOT) + path.sep)) return null;
  return abs;
}

/**
 * 이미지들을 디스크에 쓴다.
 * @returns {{ saved:[{path,bytes,mime,kind,name}], failed:number, reason:string|null }}
 *   ⛔던지지 않는다 — 호출부가 「이미지는 못 넣었지만 신고는 접수」로 이어가야 하기 때문이다.
 */
async function saveImages(reportId, images, opts = {}) {
  const out = { saved: [], failed: 0, reason: null };
  const id = safeId(reportId);
  if (!id || !Array.isArray(images) || !images.length) return out;

  const bucket = new Date().toISOString().slice(0, 7);    // 'YYYY-MM' — 달 단위로 갈라 한 폴더가 무한히 커지지 않게
  const dir = path.join(ROOT, bucket, id);

  if (!(await hasFreeSpace(ROOT).catch(() => true))) {
    out.failed = images.length;
    out.reason = 'disk_full';
    return out;
  }

  try {
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  } catch (err) {
    // ★여기가 systemd ReadWritePaths 미개방 시 떨어지는 자리다(EACCES/EROFS).
    out.failed = images.length;
    out.reason = err.code === 'EACCES' || err.code === 'EROFS' ? 'storage_readonly' : 'storage_unavailable';
    return out;
  }

  for (let i = 0; i < images.length; i++) {
    const dec = images[i] && images[i].__decoded;
    if (!dec) { out.failed++; continue; }
    const ext = MIME_EXT[dec.mime];
    const rel = `${bucket}/${id}/${i}.${ext}`;
    try {
      await fs.promises.writeFile(path.join(ROOT, rel), dec.buf, { mode: 0o600 });
      out.saved.push({
        path: rel,
        bytes: dec.buf.length,
        mime: dec.mime,
        kind: images[i].kind === 'capture' ? 'capture' : 'attach',
        // 파일 이름은 사용자가 준 값이다 — 길이만 자르고 «경로로 쓰지 않는다»(저장명은 i.ext 로 우리가 정한다)
        name: String(images[i].name || '').slice(0, 120),
      });
    } catch (err) {
      out.failed++;
      out.reason = out.reason || 'write_failed';
    }
  }
  return out;
}

/** 어드민 열람용 — 상대경로로 실제 파일을 읽는다. 없거나 경로가 수상하면 null. */
async function readStored(relPath) {
  const abs = resolveStored(relPath);
  if (!abs) return null;
  try {
    const buf = await fs.promises.readFile(abs);
    return { buf, abs };
  } catch { return null; }
}

module.exports = { ROOT, MIME_EXT, decodeImage, saveImages, readStored, resolveStored, safeId };
