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
 * 섹션 HTML 하나가 수 MB 일 수 있다 — 캔버스에 base64 이미지가 박힌다.
 * 두 개의 «다른» 천장이 있다는 걸 알고 잡은 숫자다:
 *   ① _lib/util.readJsonBody 는 스트림으로 읽을 때 1e6(1MB)에서 끊는다.
 *   ② Vercel 은 함수에 들어오기 «전에» req.body 를 자기가 파싱하고(그래서 ①의 가드가 안 탄다)
 *      4.5MB 를 넘으면 우리 코드가 돌기도 전에 413 을 뱉는다.
 * ⇒ 둘 중 «낮은 쪽»(1MB) 아래로 우리 한도를 잡아야 로컬과 배포가 같게 군다.
 *   여기서 막으면 이유를 말해줄 수 있지만, ①/②에서 막히면 앱은 정체불명의 오류만 받는다.
 */
const MAX_HTML_CHARS = 700000;      // 섹션 1개
const MAX_PAYLOAD_CHARS = 900000;   // patches / snapshot 전체 (1MB 천장 아래)
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

// ★존재 자체를 알려주지 않는다 — 「내 것이 아님」과 「없음」이 같은 응답이다.
function notFound(res) {
  return json(res, 404, { ok: false, reason: 'project_not_found' });
}

function tooLarge(res, detail) {
  return json(res, 413, { ok: false, reason: 'payload_too_large', ...detail });
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

/* JSON 으로 직렬화했을 때의 문자 수. 크기 판정은 «보낸 값 기준»이어야 말이 된다. */
function jsonSize(value) {
  try { return JSON.stringify(value ?? null).length; }
  catch { return Infinity; }
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
  MAX_HTML_CHARS,
  MAX_PAYLOAD_CHARS,
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
  authenticate,
  unauthorized,
  notFound,
  tooLarge,
  loadProject,
  jsonSize,
  presenceList,
  prunePatches,
};
