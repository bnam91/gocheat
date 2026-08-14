const { getDb } = require('../mongo');
const { json, handlePreflight, readJsonBody } = require('../util');
const {
  MAX_PATCHES_PER_PULL, PRESENCE_EVICT_MS,
  isActorId, authenticate, unauthorized, notFound, loadProject, presenceList,
} = require('../collab');

/* 상대의 변경분을 받아온다. + presence 하트비트.
 *
 * 입력  { sessionToken, collabId, actorId, sinceSeq, editingSectionId?, wantSections? }
 * 출력  { ok, seq, patches, presence, hasMore, sections?, resync? }
 *
 * ★«내가 만든 패치»는 빼고 준다 — 에코 방지. 안 그러면 방금 내가 친 글이 서버를 돌아
 *   내 캔버스를 다시 덮어쓴다(커서가 튀고, 입력 중이면 글자가 씹힌다).
 *   이게 에코 가드의 «1차 방어선»이다 — 이 규칙을 빼지 마라.
 *
 * ★이 엔드포인트«만» 쓰기를 한다 — presence 갱신. pull 요청 자체가 하트비트다.
 *   별도 heartbeat 엔드포인트를 두면 앱이 두 개의 타이머를 돌려야 하고, 둘이 어긋나면
 *   「접속 중인데 편집 표시가 없다」 같은 상태가 생긴다. 폴링 한 번 = 살아있다는 신호로 묶는다.
 *
 * ★합류자는 sinceSeq=0 부터 당겨 문서를 «쌓아올린다» — 스냅샷 같은 건 없다(register 주석 참고).
 *   그래서 sinceSeq=0 일 때 «목차»를 함께 준다: 목차에 10개인데 7개만 받았으면
 *   3개는 소유자가 아직 push 하지 않은 것이다(앱이 기다릴지 재촉할지 판단할 근거).
 *   ⚠️목차는 2초 폴링에 매번 싣지 않는다. 필요하면 wantSections:true 로 명시해 받아간다.
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

    // 목차는 «필요할 때만». 첫 동기화·재동기화·명시 요청 셋뿐이다.
    const wantSections = body.wantSections === true || sinceSeq === 0 || gapLost;

    return json(res, 200, {
      ok: true,
      seq,
      serverSeq: project.seq,
      patches,
      hasMore,
      // 내 하트비트를 나에게 되돌려줄 이유가 없다 (방금 위에서 찍은 값이다)
      presence: presenceList(project, now.getTime()).filter((p) => p.actorId !== actorId),
      ...(gapLost ? { resync: true, reason: 'patches_pruned', patchFloorSeq: floor } : {}),
      ...(wantSections ? { sections: project.sections || [] } : {}),
    });
  } catch (err) {
    console.error('[collab/pull] error', err);
    return json(res, 500, { ok: false, reason: 'internal_error' });
  }
};
