/**
 * DB 백업 — 전 컬렉션을 EJSON 으로 떠서 gzip 으로 보관한다.
 *
 * ★왜 mongodump 가 아닌가
 *   EC2(Amazon Linux 2023)에 mongodump 가 없고 repo 도 없다. 넣으려면 MongoDB 공식 repo 를
 *   시스템에 추가해야 하는데, «백업 하나» 때문에 패키지 소스를 늘리는 건 값이 안 맞는다.
 *   ★지금 DB 는 아주 작다(문서 53건 · 0.0MB). 이 규모에선 EJSON 덤프로 충분하고,
 *     드라이버가 이미 있어 «설치가 필요 없다». 복원도 같은 드라이버로 한다.
 *   ⚠️DB 가 커지면(수십만 건·수백MB) 그때는 mongodump 로 갈아타라. 이 파일은 그때 버리면 된다.
 *
 * ★EJSON 을 쓰는 이유 — 그냥 JSON.stringify 하면 ObjectId·Date 가 «문자열»이 돼
 *   복원했을 때 타입이 달라진다. 그러면 { createdAt: { $gte: ... } } 같은 질의가 조용히 빗나간다.
 *
 * ⛔백업 파일에는 «전 사용자 데이터»가 들어간다(비밀번호 해시·세션 토큰 포함).
 *   · docroot 밖에 둔다(docroot 안이면 HTTP 로 공개된다 — 이 프로젝트에서 실제로 사고가 있었다)
 *   · 파일 권한 600, 디렉터리 700
 *   ⛔로그에 파일 «내용»을 찍지 마라. 개수와 크기만.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { MongoClient } = require('/opt/goditor-api/node_modules/mongodb');
const { EJSON } = require('/opt/goditor-api/node_modules/bson');

/* ★보관 위치는 «절대경로로 못박는다» — HOME 에 기대지 않는다(2026-09-04).
 *   ⛔예전엔 HOME 을 봤다. systemd 유닛이 HOME=/home/ec2-user 를 박아 두니 «타이머는» 늘 맞았는데,
 *     사람이 `sudo node …` 로 손수 돌리면 HOME=/root 라 /root/db-backup 에 «따로» 쌓였다.
 *     ★그 상태에서 보관 개수를 세면 「보관 1개」가 나온다 — 옛 백업 3개가 다른 폴더에 있는데도.
 *     계정을 지우기 «직전»에 이걸 보고 「백업이 사라졌나」 하고 3분을 썼다. 실제로는 멀쩡했다.
 *   ⇒ 「누가 돌리느냐」로 결과가 갈리면 그건 백업이 아니다. BACKUP_DIR 로만 바꿀 수 있게 둔다. */
const OUT_DIR = process.env.BACKUP_DIR || '/home/ec2-user/db-backup';
const KEEP_DAYS = Number(process.env.BACKUP_KEEP_DAYS || 7);

(async () => {
  const uri = process.env.MONGO_URI;
  if (!uri) { console.error('[backup] MONGO_URI 없음'); process.exit(1); }
  const dbName = process.env.MONGO_DB || 'goditor_license';
  fs.mkdirSync(OUT_DIR, { recursive: true, mode: 0o700 });

  const cli = new MongoClient(uri, { serverSelectionTimeoutMS: 20000 });
  const stamp = new Date(Date.now() + 9 * 3600e3).toISOString().replace(/[:T]/g, '-').slice(0, 19); // KST
  const file = path.join(OUT_DIR, `${dbName}-${stamp}.ejson.gz`);
  try {
    await cli.connect();
    const db = cli.db(dbName);
    const cols = (await db.listCollections().toArray()).map((c) => c.name).sort();
    const dump = { _meta: { db: dbName, at: new Date().toISOString(), collections: cols.length }, data: {} };
    let total = 0;
    for (const name of cols) {
      const rows = await db.collection(name).find({}).toArray();
      dump.data[name] = rows;
      total += rows.length;
    }
    // ★한 번에 쓴다 — 부분 파일이 남으면 «있는 줄 알고» 복원했다가 데이터를 잃는다.
    //   임시 이름으로 쓰고 «다 쓴 뒤» 옮긴다(원자적 교체).
    const tmp = file + '.part';
    fs.writeFileSync(tmp, zlib.gzipSync(Buffer.from(EJSON.stringify(dump, { relaxed: false }))), { mode: 0o600 });
    fs.renameSync(tmp, file);
    const size = fs.statSync(file).size;
    console.log(`[backup] ok  컬렉션 ${cols.length} · 문서 ${total} · ${(size / 1024).toFixed(1)}KB · ${path.basename(file)}`);

    // 오래된 것 정리 — «성공한 뒤에만» 지운다. 실패했는데 지우면 백업이 통째로 없어진다.
    const cutoff = Date.now() - KEEP_DAYS * 86400e3;
    let removed = 0;
    for (const f of fs.readdirSync(OUT_DIR)) {
      if (!f.endsWith('.ejson.gz')) continue;
      const p = path.join(OUT_DIR, f);
      if (fs.statSync(p).mtimeMs < cutoff) { fs.unlinkSync(p); removed++; }
    }
    const left = fs.readdirSync(OUT_DIR).filter((f) => f.endsWith('.ejson.gz')).length;
    console.log(`[backup] 보관 ${left}개 (${KEEP_DAYS}일 초과 ${removed}개 삭제)`);
  } catch (e) {
    // ⛔삼키지 않는다 — 백업이 «조용히» 안 도는 것이 제일 위험하다.
    console.error('[backup] 실패:', e.message);
    process.exitCode = 1;
  } finally { await cli.close().catch(() => {}); }
})();
