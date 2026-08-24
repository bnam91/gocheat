const { MongoClient } = require('mongodb');

/* ★프리뷰 배포는 «자동으로» 개발 DB 를 본다 — 대시보드 설정이 필요 없다.
 *
 *   전엔 DB 이름이 하드코딩이라 브랜치 프리뷰가 «라이브와 같은 DB» 를 썼다. 그래서
 *   개발 중인 걸 확인하려면 라이브에 올리는 수밖에 없었고 실데이터가 오염됐다.
 *
 *   1차 안은 Vercel 환경변수를 「Preview 에만」 걸게 하는 것이었다. 동작은 하지만
 *   ★«사람이 잊으면 조용히 라이브 DB 를 쓴다» — 실수의 대가가 너무 크다.
 *   ⇒ VERCEL_ENV 는 Vercel 이 «항상» 넣어준다(production | preview | development).
 *     production 이 아니면 개발 DB. 설정할 것도, 잊을 것도 없다.
 *
 *   MONGO_DB 를 명시하면 그게 이긴다(로컬 실험·일회성 격리용).
 *   ★Atlas 는 클러스터 하나에 DB 를 여럿 둔다 — 클러스터를 새로 살 필요가 없다.
 */
const DB_NAME = process.env.MONGO_DB
  || (process.env.VERCEL_ENV && process.env.VERCEL_ENV !== 'production'
        ? 'goditor_license_dev'
        : 'goditor_license');

let cached = global.__goditorMongo;
if (!cached) {
  cached = global.__goditorMongo = { client: null, dbPromise: null };
}

async function getDb() {
  if (cached.dbPromise) return cached.dbPromise;

  const uri = process.env.MONGO_URI;
  if (!uri) {
    throw new Error('MONGO_URI is not set');
  }

  cached.dbPromise = (async () => {
    const client = new MongoClient(uri, {
      maxPoolSize: 5,
      serverSelectionTimeoutMS: 8000,
    });
    await client.connect();
    cached.client = client;
    const db = client.db(DB_NAME);
    await ensureIndexes(db);
    return db;
  })().catch((err) => {
    cached.dbPromise = null;
    throw err;
  });

  return cached.dbPromise;
}

let indexesEnsured = false;
async function ensureIndexes(db) {
  if (indexesEnsured) return;
  indexesEnsured = true;
  await Promise.all([
    db.collection('users').createIndex({ email: 1 }, { unique: true }),
    db.collection('users').createIndex({ verificationToken: 1 }, { sparse: true }),
    // session.js 가 토큰만으로 찾는다 — 인덱스가 없으면 컬렉션 전수주사가 된다
    db.collection('users').createIndex({ sessionToken: 1 }, { sparse: true }),
    // ★2026-08-25 제품별 세션(_lib/sessions.js) — 배열 안 토큰으로도 찾는다. 없으면 여기도 전수주사.
    db.collection('users').createIndex({ 'sessions.token': 1 }, { sparse: true }),
    db.collection('licenses').createIndex({ key: 1 }, { unique: true }),
    db.collection('licenses').createIndex({ userEmail: 1, status: 1 }),
    db.collection('mail_queue').createIndex({ idempotencyKey: 1 }, { unique: true }),
    db.collection('mail_queue').createIndex({ status: 1, createdAt: 1 }),

    // ── 원격 동시협업 (api/collab/*) ──────────────────────────────────────
    // ★인덱스는 이 파일 «한 곳»에 모은다 — 컬렉션마다 흩어두면 어디를 봐야 할지 모르게 된다.
    //   createIndex 는 이미 있으면 no-op 이라 콜드스타트마다 불러도 안전하다.
    db.collection('collab_projects').createIndex({ collabId: 1 }, { unique: true }),
    db.collection('collab_projects').createIndex({ members: 1 }),
    // register 멱등성 — 같은 로컬 프로젝트를 두 번 올려도 하나여야 한다
    db.collection('collab_projects').createIndex({ ownerEmail: 1, localProjectId: 1 }),
    db.collection('collab_invites').createIndex({ inviteId: 1 }, { unique: true }),
    db.collection('collab_invites').createIndex({ email: 1, status: 1 }),
    db.collection('collab_invites').createIndex({ collabId: 1, email: 1, status: 1 }),
    db.collection('collab_patches').createIndex({ collabId: 1, seq: 1 }, { unique: true }),
    // ★TTL 은 «버려진 프로젝트» 청소용 안전망이다. 살아있는 프로젝트는 500개 상한(prunePatches)이
    //   항상 먼저 걸리므로, 최신 패치가 이 TTL 로 사라지는 일은 없다. (근거: _lib/collab.js 주석)
    db.collection('collab_patches').createIndex(
      { createdAt: 1 },
      { expireAfterSeconds: 7 * 24 * 60 * 60 },
    ),

    // ── 고디브 사용 원장 (api/godiv/use.js) ────────────────────────────────
    // 계정별 조회(추이·재방문)와 전체 일자별 집계(사이트별 성공률)를 «둘 다» 본다.
    db.collection('godiv_events').createIndex({ email: 1, at: -1 }),
    db.collection('godiv_events').createIndex({ site: 1, at: -1 }),
    // ★TTL — 원장은 «자동으로 사라진다». 이건 성능이 아니라 «약속»이다:
    //   처리방침에 「이용 기록은 최대 180일 보관 후 자동 파기」라고 적어 두었다(godiv.html#privacy).
    //   ⚠️기간을 바꾸려면 처리방침을 «먼저» 고쳐라. 그리고 createIndex 로는 못 바꾼다
    //     (이미 있는 인덱스에 다른 expireAfterSeconds → IndexOptionsConflict) — collMod 로 바꿔야 한다.
    //   ★계정 요약(users.usage.godiv.*)은 여기 안 걸린다 — 누적 카운터라 원본이 사라져도 남는다.
    db.collection('godiv_events').createIndex(
      { at: 1 },
      { expireAfterSeconds: 180 * 24 * 60 * 60 },
    ),
  ]).catch((err) => {
    indexesEnsured = false;
    throw err;
  });
}

module.exports = { getDb, DB_NAME };
