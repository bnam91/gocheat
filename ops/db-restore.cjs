/**
 * DB 복원 — 백업 파일을 «지정한 DB 이름»으로 되돌린다.
 *
 * 쓰는 법
 *   node ops/db-restore.cjs <백업파일> --to <DB이름> [--drop]
 *   예) node /opt/goditor-ops/db-restore.cjs ~/db-backup/xxx.ejson.gz --to restore_test
 *
 * ⛔★--to 는 «필수»다. 기본값을 두지 않는다 —
 *   실수로 운영 DB(goditor_license)에 덮어쓰는 사고를 «구조로» 막는다.
 * ⛔운영 DB 이름으로 복원하려면 --force 까지 있어야 한다. 그것도 사람이 직접 칠 때만.
 *
 * ★★복원 «테스트»는 --prefix 로 한다:
 *   node db-restore.cjs <파일> --to goditor_license --force --prefix _rt_
 *   → 같은 DB 안에 «_rt_users» 처럼 접두사를 붙여 넣는다. 운영 컬렉션은 손대지 않는다.
 *   ⚠️왜 다른 DB 이름을 못 쓰나 — Atlas 사용자 권한이 goditor_license «한 DB에만» 걸려 있어
 *     다른 DB 로는 insert 가 거부된다(2026-09-03 실측: not allowed to do action [insert]).
 *     그건 운영 관행상 «정상»이다. 그래서 같은 DB 안에서 이름을 갈라 검증한다.
 *   ⛔테스트가 끝나면 접두사 컬렉션을 «반드시» 지워라(--cleanup).
 */
const fs = require('fs');
const zlib = require('zlib');
const { MongoClient } = require('/opt/goditor-api/node_modules/mongodb');
const { EJSON } = require('/opt/goditor-api/node_modules/bson');

const args = process.argv.slice(2);
const file = args[0];
const toIdx = args.indexOf('--to');
const target = toIdx >= 0 ? args[toIdx + 1] : null;
const drop = args.includes('--drop');
const force = args.includes('--force');
const pIdx = args.indexOf('--prefix');
const prefix = pIdx >= 0 ? args[pIdx + 1] : '';
const cleanup = args.includes('--cleanup');

if (!file || !target) {
  console.error('사용법: node db-restore.cjs <백업파일> --to <DB이름> [--drop]');
  process.exit(1);
}
const PROD = process.env.MONGO_DB || 'goditor_license';
// ★접두사가 있으면 «운영 컬렉션을 건드리지 않는다»는 뜻이라 운영 DB 이름도 허용한다.
if (target === PROD && !force && !prefix) {
  console.error(`⛔ 운영 DB(${PROD})로 복원하려면 --force 가 필요하다. 테스트는 다른 이름으로 해라.`);
  process.exit(1);
}

(async () => {
  const uri = process.env.MONGO_URI;
  if (!uri) { console.error('[restore] MONGO_URI 없음'); process.exit(1); }
  const dump = EJSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString());
  const cli = new MongoClient(uri, { serverSelectionTimeoutMS: 20000 });
  try {
    await cli.connect();
    const db = cli.db(target);
    console.log(`[restore] ${file}\n  → DB «${target}» · 원본 ${dump._meta.db} · 뜬 시각 ${dump._meta.at}`);
    // ★정리 모드 — 테스트로 만든 접두사 컬렉션만 지운다. 접두사가 없으면 «아무것도 안 한다».
    if (cleanup) {
      if (!prefix) { console.error('⛔ --cleanup 은 --prefix 와 함께여야 한다(운영 컬렉션을 지울 뻔한다)'); process.exit(1); }
      let n = 0;
      for (const c of await db.listCollections().toArray()) {
        if (c.name.startsWith(prefix)) { await db.collection(c.name).drop().catch(() => {}); n++; }
      }
      console.log(`[restore] 정리 완료 — «${prefix}» 접두사 컬렉션 ${n}개 삭제`);
      return;
    }
    let total = 0;
    for (const [name, rows] of Object.entries(dump.data)) {
      const dest = prefix + name;
      if (drop) await db.collection(dest).drop().catch(() => {});
      if (rows.length) await db.collection(dest).insertMany(rows, { ordered: false });
      total += rows.length;
      console.log(`    ${dest.padEnd(24)} ${rows.length}건`);
    }
    console.log(`[restore] ok  컬렉션 ${Object.keys(dump.data).length} · 문서 ${total}`);
  } catch (e) {
    console.error('[restore] 실패:', e.message);
    process.exitCode = 1;
  } finally { await cli.close().catch(() => {}); }
})();
