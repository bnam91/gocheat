const crypto = require('crypto');
const { json } = require('./util');

/* 원격 동시협업(goditor) 공용 부품.
 *
 * ★설계 전제 — 바꾸려면 여기 주석부터 고쳐라
 *   · 전송  = HTTP 폴링 2초. Vercel 에 WebSocket 이 없다. 앱이 주기적으로 pull 한다.
 *   · 단위  = «섹션 1개». 캔버스가 HTML 문자열이라 CRDT 를 못 얹는다 — 델타는 섹션 통째 교체다.
 *   · 충돌  = seq 기반 last-writer-wins + keep-both. ★서버는 아무것도 «버리지» 않는다.
 *            충돌이라고 표시해 돌려줄 뿐, 어느 쪽을 살릴지는 사람이 앱에서 고른다.
 *   · 인증  = 기존 users.sessionToken 을 그대로 쓴다(앱이 이미 갖고 있다). 새 토큰 체계를 만들지 않는다.
 *
 * ⛔«없는 프로젝트»와 «남의 프로젝트»는 «같은 404» 다 (403 아님).
 *   403 은 「그 프로젝트는 있다」를 알려준다 — collabId 를 넣어보며 존재를 캐낼 수 있다.
 *   session.js 가 「없음」과 「불일치」를 같은 401 로 돌려주는 것과 같은 이유다.
 */

/* ── 크기 한도 ─────────────────────────────────────────────────────────────
 * 섹션 HTML 하나가 수 MB 일 수 있다 — 캔버스에 base64 이미지가 박힌다(실측 85MB 프로젝트 사례).
 * 두 개의 «다른» 천장이 있다는 걸 알고 잡은 숫자다:
 *   ① _lib/util.readJsonBody 는 스트림으로 읽을 때 1e6(1MB)에서 끊는다.
 *   ② Vercel 은 함수에 들어오기 «전에» req.body 를 자기가 파싱하고(그래서 ①의 가드가 안 탄다)
 *      4.5MB 를 넘으면 우리 코드가 돌기도 전에 413 을 뱉는다.
 * ⇒ 둘 중 «낮은 쪽»(1MB) 아래로 우리 한도를 잡아야 로컬과 배포가 같게 군다.
 *   여기서 막으면 «어느 섹션이 몇 바이트라서» 막혔는지 말해줄 수 있지만,
 *   ①/②에서 막히면 앱은 정체불명의 오류만 받고 사용자에게 아무 말도 못 한다.
 *
 * ★단위는 «문자»가 아니라 «바이트»다(2026-08-15 정정). base64·한글이 섞이면 UTF-8 바이트가
 *   문자 수보다 크다 — 천장 ①②가 바이트로 재므로 우리도 바이트로 재야 «먼저» 걸린다.
 */
const MAX_SECTION_BYTES = 700000;   // 섹션 1개
const MAX_PAYLOAD_BYTES = 900000;   // 한 요청 전체 (1MB 천장 아래)
/* ★한 요청 = 섹션 «1개»가 기본이다(지디 2026-08-15). 배열도 받지만 실질 제한은 합계 크기다 —
 *   이미지 박힌 섹션 둘만 담아도 한도를 넘는다. 개수 상한은 사고 방지용 뚜껑일 뿐이다. */
const MAX_PATCHES_PER_PUSH = 50;

/* 패치 보존 정책 (근거를 남긴다)
 *   collab_patches 는 편집할수록 «무한히» 쌓인다. 2초 폴링이라 한 세션에 수천 건이 난다.
 *   ① 프로젝트당 최근 500개만 남긴다 — pull 은 sinceSeq 이후만 읽으므로 과거는 재생에 안 쓰인다.
 *      500 = 2초 폴링에서 «수십 분» 자리비움까지 따라잡을 수 있는 양. 그보다 뒤처지면 어차피 재동기화가 싸다.
 *   ② TTL 7일 — 버려진 프로젝트의 잔여물 청소용 «안전망»이다. ①이 항상 먼저 걸리므로
 *      살아있는 프로젝트의 최신 패치가 TTL 로 지워질 일은 없다.
 *   ★잘라낸 구간을 요구하는 pull 은 조용히 «빠뜨리면» 안 된다 → patchFloorSeq 로 감지해 resync 를 지시한다.
 */
const MAX_PATCHES_PER_PROJECT = 500;
const PATCH_TTL_SECONDS = 7 * 24 * 60 * 60;
const PRUNE_EVERY = 100;            // seq 가 이 배수를 넘을 때만 정리한다(매 push 마다 세지 않는다)

const MAX_PATCHES_PER_PULL = 200;   // 응답 크기 방어. 잘리면 hasMore 로 알린다.

// presence: 화면에 「상대가 편집 중」을 띄우는 용도. pull 요청 «자체»가 하트비트다.
const PRESENCE_FRESH_MS = 30 * 1000;      // 이 안에 pull 했으면 «접속 중»으로 본다
const PRESENCE_EVICT_MS = 10 * 60 * 1000; // 이보다 오래된 항목은 문서에서 지운다(무한 증식 방지)

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(9).toString('hex')}`;
}

/* actorId 는 앱이 만든다 — 그대로 presence 의 «필드 이름»이 되므로 모양을 강제한다.
 * 점(.)이나 $ 가 들어오면 Mongo 업데이트 경로가 깨진다. 넓게 받고 조용히 망가지느니 좁게 받고 거절한다. */
const ACTOR_RE = /^[A-Za-z0-9_-]{1,64}$/;
function isActorId(v) {
  return typeof v === 'string' && ACTOR_RE.test(v);
}

function isCollabId(v) {
  return typeof v === 'string' && /^cb_[0-9a-f]{18}$/.test(v);
}

function isInviteId(v) {
  return typeof v === 'string' && /^iv_[0-9a-f]{18}$/.test(v);
}

/* sessionToken → user.
 * ★session.js 와 같은 규칙이다. 「토큰 없음」·「토큰 불일치」·「미인증」을 갈라 말하지 않는다.
 * 조회만 한다 — 여기서 lastSeenAt 같은 걸 찍으면 이 경로 전체가 계측기가 된다(session.js 주석 참고). */
async function authenticate(db, sessionToken) {
  const token = typeof sessionToken === 'string' ? sessionToken.trim() : '';
  if (!token) return null;
  const user = await db.collection('users').findOne({ sessionToken: token });
  if (!user || !user.verified) return null;
  return user;
}

function unauthorized(res) {
  return json(res, 401, { ok: false, reason: 'invalid_session' });
}

/* ★404 에는 «반드시 JSON 본문»이 있어야 한다 (앱 계약, 2026-08-15).
 *   앱은 「404 인데 JSON 이 없다」를 «아직 배포 안 된 엔드포인트»로 읽는다.
 *   본문 없이 404 를 뱉으면 멤버가 아닌 게 아니라 서버가 없는 걸로 오판한다.
 *
 * ★그리고 「없는 프로젝트」와 「내 것이 아님」은 «똑같은» 응답이다 — reason 까지 같다.
 *   reason 을 갈라 말하면(project_not_found / not_a_member) collabId 를 넣어보는 것만으로
 *   「그 방은 실재한다」를 알아낼 수 있다. 403 을 피한 이유가 그거였으니 여기서 도로 흘리면 안 된다.
 *   ⇒ 실재하지 않는 방에도 not_a_member 라고 답한다. 이름이 살짝 헐렁한 게 아니라 «그게 요점»이다. */
function notFound(res) {
  return json(res, 404, { ok: false, reason: 'not_a_member' });
}

/* 413 — «어느 섹션이 몇 바이트라서» 막혔는지 반드시 짚어준다.
 * 그냥 413 만 주면 앱은 사용자에게 아무 말도 못 한다.
 * ★limit 도 같이 실어 보낸다 — 앱이 한도를 하드코딩하지 않게(서버가 바꾸면 그날부터 따라온다). */
function tooLarge(res, detail) {
  return json(res, 413, { ok: false, reason: 'payload_too_large', ...detail });
}

function sectionTooLarge(res, { sectionId, bytes, limit }) {
  return json(res, 413, { ok: false, reason: 'section_too_large', sectionId, bytes, limit });
}

// UTF-8 실바이트. 한도가 바이트 기준이므로 문자 수로 재면 큰 페이로드를 놓친다.
function byteLen(value) {
  if (typeof value === 'string') return Buffer.byteLength(value, 'utf8');
  try { return Buffer.byteLength(JSON.stringify(value ?? null), 'utf8'); }
  catch { return Infinity; }
}

/* 멤버인 활성 프로젝트만 돌려준다. 아니면 null → 호출부는 무조건 notFound() 로 답한다. */
async function loadProject(db, collabId, email) {
  if (!isCollabId(collabId)) return null;
  return db.collection('collab_projects').findOne({
    collabId,
    status: 'active',
    members: email,
  });
}

function isSectionId(v) {
  return typeof v === 'string' && v.length > 0 && v.length <= 100;
}

/* 목차(sections) 병합 — «합집합»이다. 서버에만 있는 항목을 지우지 않는다.
 *
 * ★왜 덮어쓰지 않나: register 는 소유자가 앱을 켤 때마다 다시 부를 수 있다(멱등).
 *   그 사이 상대가 새 섹션을 push 했다면, 소유자가 보낸 목차엔 그게 «아직 없다».
 *   소유자 목차로 통째 덮으면 상대가 만든 섹션이 목차에서 조용히 사라진다 —
 *   그러면 「누가 무엇을 아직 못 받았나」 판단이 틀어진다.
 *   ⇒ 들어온 것으로 hash 를 갱신하고, 서버에만 있던 항목은 그대로 둔다.
 *   ⚠️섹션 «삭제»는 이 경로로 못 한다. 삭제 동기화가 필요해지면 별도 패치 종류로 낼 일이다.
 */
function mergeSections(existing, incoming) {
  const out = (existing || []).map((s) => ({ ...s }));
  const byId = new Map(out.map((s) => [s.sectionId, s]));
  for (const s of incoming || []) {
    const hit = byId.get(s.sectionId);
    if (hit) {
      if (s.hash) hit.hash = s.hash;
      if (s.pageId) hit.pageId = s.pageId;
    } else {
      const row = { sectionId: s.sectionId, pageId: s.pageId || null, hash: s.hash || null, seq: 0 };
      out.push(row);
      byId.set(row.sectionId, row);
    }
  }
  return out;
}

/* 앱이 보낸 목차를 «정리»해서 돌려준다. 모양이 틀리면 null(→ 400). */
function normalizeSections(input) {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) return null;
  if (input.length > 500) return null;          // 상세페이지 한 장에 섹션 500개는 사고다
  const out = [];
  const seen = new Set();
  for (const s of input) {
    if (!s || !isSectionId(s.sectionId)) return null;
    if (seen.has(s.sectionId)) continue;        // 중복은 조용히 접는다(앱이 두 번 담아도 사고가 아니다)
    seen.add(s.sectionId);
    out.push({
      sectionId: s.sectionId,
      pageId: typeof s.pageId === 'string' ? s.pageId.slice(0, 100) : null,
      hash: typeof s.hash === 'string' ? s.hash.slice(0, 128) : null,
    });
  }
  return out;
}

/* presence 맵 → 화면에 줄 배열. 오래된 항목은 빼고 준다(문서에서 지우는 건 pull 이 따로 한다). */
function presenceList(project, now = Date.now()) {
  const raw = project && project.presence ? project.presence : {};
  return Object.keys(raw)
    .map((actorId) => ({ actorId, ...raw[actorId] }))
    .filter((p) => p.lastSeenAt && now - new Date(p.lastSeenAt).getTime() < PRESENCE_FRESH_MS)
    .map((p) => ({
      actorId: p.actorId,
      email: p.email || null,
      editingSectionId: p.editingSectionId || null,
      lastSeenAt: p.lastSeenAt,
    }));
}

/* 오래된 패치 잘라내기 + patchFloorSeq 갱신.
 * ★floor 를 «반드시» 기록해야 한다. 안 그러면 뒤처진 클라이언트가 사라진 구간을
 *   «변경 없음»으로 착각하고 지나간다 — 조용한 유실이다. */
async function prunePatches(db, collabId) {
  const patches = db.collection('collab_patches');
  const total = await patches.countDocuments({ collabId });
  if (total <= MAX_PATCHES_PER_PROJECT) return null;

  const drop = total - MAX_PATCHES_PER_PROJECT;
  const doomed = await patches.find({ collabId }, { projection: { seq: 1 } })
    .sort({ seq: 1 }).limit(drop).toArray();
  if (!doomed.length) return null;

  const cutoff = doomed[doomed.length - 1].seq;
  await patches.deleteMany({ collabId, seq: { $lte: cutoff } });
  const floor = cutoff + 1;
  await db.collection('collab_projects').updateOne(
    { collabId },
    { $set: { patchFloorSeq: floor } },
  );
  return floor;
}

module.exports = {
  MAX_SECTION_BYTES,
  MAX_PAYLOAD_BYTES,
  MAX_PATCHES_PER_PUSH,
  MAX_PATCHES_PER_PROJECT,
  MAX_PATCHES_PER_PULL,
  PATCH_TTL_SECONDS,
  PRUNE_EVERY,
  PRESENCE_FRESH_MS,
  PRESENCE_EVICT_MS,
  newId,
  isActorId,
  isCollabId,
  isInviteId,
  isSectionId,
  authenticate,
  unauthorized,
  notFound,
  tooLarge,
  sectionTooLarge,
  loadProject,
  byteLen,
  mergeSections,
  normalizeSections,
  presenceList,
  prunePatches,
};
