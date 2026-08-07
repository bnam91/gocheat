const { MongoClient } = require('mongodb');

// ★DB 이름을 «환경변수»로 뺀다 — 이게 없으면 프리뷰 배포가 라이브와 «같은 DB»를 쓴다.
//   그러면 개발 중인 걸 확인하려면 라이브에 올리는 수밖에 없고, 실데이터가 오염된다.
//   Atlas 는 클러스터 하나에 DB 를 여럿 둘 수 있다 — 클러스터를 새로 살 필요가 없다.
//   Vercel 환경변수를 «Preview 에만» MONGO_DB=goditor_license_dev 로 두면
//   브랜치 프리뷰가 자동으로 개발 DB 를 본다. Production 은 값이 없어 기존 이름 그대로다.
const DB_NAME = process.env.MONGO_DB || 'goditor_license';

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
