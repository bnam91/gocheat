const { getDb } = require('../_lib/mongo');
const { json, handlePreflight, readJsonBody } = require('../_lib/util');
const {
  MAX_PATCHES_PER_PULL, PRESENCE_EVICT_MS,
  isActorId, authenticate, unauthorized, notFound, loadProject, presenceList,
} = require('../_lib/collab');

/* 상대의 변경분을 받아온다. + presence 하트비트.
 *
 * 입력  { sessionToken, collabId, actorId, sinceSeq, editingSectionId? }
 * 출력  { ok, seq, patches:[...], presence:[...], hasMore, resync?, snapshot? }
 *
 * ★«내가 만든 패치»는 빼고 준다 — 에코 방지. 안 그러면 방금 내가 친 글이 서버를 돌아
 *   내 캔버스를 다시 덮어쓴다(커서가 튀고, 입력 중이면 글자가 씹힌다).
 *
 * ★이 엔드포인트«만» 쓰기를 한다 — presence 갱신. pull 요청 자체가 하트비트다.
 *   별도 heartbeat 엔드포인트를 두면 앱이 두 개의 타이머를 돌려야 하고, 둘이 어긋나면
 *   「접속 중인데 편집 표시가 없다」 같은 상태가 생긴다. 폴링 한 번 = 살아있다는 신호로 묶는다.
 *
 * ★sinceSeq=0 이면 snapshot 을 함께 준다 — 합류자의 초기 상태. 이후 폴링은 sinceSeq>0 이라
 *   두 번 다시 실리지 않는다(2초마다 MB 를 태우면 안 된다).
 */
module.exports = async (req, res) => {
  if (handlePreflight(req, res, { origin: '*' })) return;
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });
  res.setHeader('Access-Control-Allow-Origin', '*');

  let body;
  try { body = await readJsonBody(req); }
  catch (err) { return json(res, 400, { error: 'invalid_body', detail: err.message }); }

  const actorId = body.actorId;
  if (!isActorId(actorId)) return json(res, 400, { ok: false, reason: 'invalid_actor_id' });

  const sinceSeq = Number.isFinite(body.sinceSeq) && body.sinceSeq >= 0 ? Math.floor(body.sinceSeq) : 0;
  const editingSectionId = typeof body.editingSectionId === 'string'
    ? body.editingSectionId.slice(0, 100) : null;

  try {
    const db = await getDb();
    const user = await authenticate(db, body.sessionToken);
    if (!user) return unauthorized(res);

    const project = await loadProject(db, body.collabId, user.email);
    if (!project) return notFound(res);

    const collabId = project.collabId;
    const now = new Date();

    // ── presence 하트비트 (+ 오래 죽어있는 항목 청소)
    // ★actorId 는 그대로 필드 이름이 된다 — _lib/collab.isActorId 가 점/$ 를 막아준다.
    const stale = Object.keys(project.presence || {}).filter((id) => {
      if (id === actorId) return false;
      const seen = (project.presence[id] || {}).lastSeenAt;
      return !seen || now.getTime() - new Date(seen).getTime() > PRESENCE_EVICT_MS;
    });
    await db.collection('collab_projects').updateOne({ collabId }, {
      $set: {
        [`presence.${actorId}`]: { email: user.email, editingSectionId, lastSeenAt: now },
      },
      // ⚠️빈 $unset 은 Mongo 가 거절한다 — 지울 게 없으면 연산자를 아예 빼야 한다
      ...(stale.length
        ? { $unset: Object.fromEntries(stale.map((id) => [`presence.${id}`, ''])) }
        : {}),
    });

    // ── 잘려나간 구간을 요구하고 있나? (patchFloorSeq = 아직 살아있는 가장 오래된 seq)
    // ★조용히 «빈 목록»을 주면 클라이언트는 「변경 없음」으로 알고 영영 어긋난 채로 산다.
    //   차라리 재동기화하라고 말한다.
    const floor = project.patchFloorSeq || 1;
    const gapLost = sinceSeq > 0 && sinceSeq + 1 < floor;

    let patches = [];
    let hasMore = false;
    let seq = project.seq;

    if (!gapLost) {
      patches = await db.collection('collab_patches').find(
        { collabId, seq: { $gt: sinceSeq }, actorId: { $ne: actorId } },
        { projection: { _id: 0, conflictWith: 0 } },
      ).sort({ seq: 1 }).limit(MAX_PATCHES_PER_PULL + 1).toArray();

      hasMore = patches.length > MAX_PATCHES_PER_PULL;
      if (hasMore) {
        patches = patches.slice(0, MAX_PATCHES_PER_PULL);
        // ★잘랐으면 프로젝트의 현재 seq 를 주면 «안 된다» — 못 준 구간을 건너뛰게 된다.
        //   실제로 건넨 마지막 패치까지만 진도를 인정한다.
        seq = patches[patches.length - 1].seq;
      }
    }

    return json(res, 200, {
      ok: true,
      seq,
      serverSeq: project.seq,
      patches,
      hasMore,
      presence: presenceList({ ...project, presence: { ...(project.presence || {}) } }, now.getTime())
        .filter((p) => p.actorId !== actorId),   // 내 하트비트를 나에게 되돌려줄 이유가 없다
      ...(gapLost ? { resync: true, reason: 'patches_pruned', patchFloorSeq: floor } : {}),
      // 합류자 초기 상태 — sinceSeq=0 일 때만 (또는 재동기화 지시를 받은 직후)
      ...(sinceSeq === 0 || gapLost ? {
        snapshot: project.snapshot || null,
        snapshotSeq: project.snapshotSeq || 0,
        /* ★정직하게 말한다: snapshot 이 오래됐고 그 뒤 구간이 이미 잘려나갔으면
         *   「snapshot + 남은 패치」로도 «완전»하지 않다. 서버는 그 구멍을 메울 수 없다
         *   — 소유자가 register 를 다시 불러 snapshot 을 새로 올려야 한다.
         *   빈틈을 숨기고 온전한 척하면 두 사람 화면이 소리 없이 달라진다. */
        snapshotStale: floor > (project.snapshotSeq || 0) + 1,
      } : {}),
    });
  } catch (err) {
    console.error('[collab/pull] error', err);
    return json(res, 500, { ok: false, reason: 'internal_error' });
  }
};
