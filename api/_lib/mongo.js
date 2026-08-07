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
    db.collection('licenses').createIndex({ key: 1 }, { unique: true }),
    db.collection('licenses').createIndex({ userEmail: 1, status: 1 }),
    db.collection('mail_queue').createIndex({ idempotencyKey: 1 }, { unique: true }),
    db.collection('mail_queue').createIndex({ status: 1, createdAt: 1 }),
  ]).catch((err) => {
    indexesEnsured = false;
    throw err;
  });
}

module.exports = { getDb, DB_NAME };
