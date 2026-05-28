const { MongoClient } = require('mongodb');

const DB_NAME = 'goditor_license';

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
