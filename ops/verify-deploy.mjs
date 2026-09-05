#!/usr/bin/env node
/* 배포 마커 검사 — 「DEPLOY_SHA 가 «실제로 올라간 파일»과 같은 것을 가리키는가」
 *
 * ★왜 필요한가 (2026-09-05 실측)
 *   서버 DEPLOY_SHA 가 1ec0cd2(2026-09-02)를 가리키고 있었는데, 실제 파일은
 *   그보다 «108 커밋 앞선» 것이었다. 사흘 동안 「지금 라이브에 뭐가 올라가 있나」에
 *   거짓 답을 하고 있었다는 뜻이다.
 *   ⚠️이번엔 «파일이 더 새것»이라 사고가 안 났다. 반대였으면 — 파일은 옛것인데
 *     마커만 최신이면 — 아무도 못 알아챈다. 그쪽이 진짜 위험한 방향이다.
 *
 * ★근본 원인은 사람의 부주의가 아니라 «구조»다.
 *   파일 복사와 마커 기록이 «따로 노는 손 작업»이라, 하나만 해도 아무도 안 막는다.
 *   ⇒ 그래서 「앞으로 잘 갱신하겠다」는 대책이 아니다. 어긋나면 «실패하는 검사»가 대책이다.
 *
 * ★어떻게 재나 — 서버에 git 이 «없다». 그래서 git 을 서버에 깔지 않고,
 *   git blob 해시를 «직접» 계산한다:  sha1("blob <바이트수>\0" + 내용)
 *   이 값이 곧 git ls-tree 가 말하는 블롭 해시라, 서버 파일과 커밋을 직접 대조할 수 있다.
 *   ⇒ 파일을 내려받지 않는다. 서버에서 해시만 계산해 가져온다.
 *
 * 사용:
 *   node ops/verify-deploy.mjs                 # 검사만 (어긋나면 exit 1)
 *   node ops/verify-deploy.mjs --sha <sha>     # DEPLOY_SHA 대신 이 커밋과 대조
 *   node ops/verify-deploy.mjs --json          # 기계용 출력
 *
 * ⛔이 스크립트는 «읽기 전용»이다. 고치지 않는다 — 고치는 건 배포 스크립트의 일이다.
 */
import { execFileSync } from 'node:child_process';

const SSH_KEY  = process.env.HP_SSH_KEY  || `${process.env.HOME}/.config/aws-wp-keys/oneulpost-v2`;
const SSH_HOST = process.env.HP_SSH_HOST || 'ec2-user@100.67.191.40';
const DOCROOT  = process.env.HP_DOCROOT  || '/opt/goditor-api';

/* ★검사 «대상»을 여기서 못 박는다.
 *   docroot 에는 레포에 없는 것도 산다(node_modules · 런타임 산출물 · 서버 전용 파일).
 *   그걸 다 대조하면 «늘 빨간불»이라 아무도 안 본다 — 검사가 죽는 가장 흔한 방식이다.
 *   ⇒ 「웹이 서빙하는 정적 파일」만 본다. api/ 는 vhost 가 막아 둔 서버 코드라 제외한다. */
const INCLUDE = /^(?:[^/]+\.(?:html|css|js|mjs)|assets\/.+|data\/.+\.json)$/;
const EXCLUDE = /^(?:node_modules\/|api\/|server\/|bin\/|scripts\/|ops\/|docs\/|package(?:-lock)?\.json$)|\.md$/;

/* ⚠️.md 를 빼는 이유 — assets/shots/README.md 가 실제로 걸렸다(2026-09-05 첫 실행).
 *   레포 «설명 문서»지 사이트가 서빙하는 자산이 아니다. 서버에 없는 게 정상이다.
 *   ⛔이런 걸 그냥 두면 검사가 «늘 빨간불»이 되고, 그 순간 아무도 안 본다 —
 *     검사가 죽는 가장 흔한 방식이 「실패가 기본값이 되는 것」이다.
 *   ★대신 «규칙»으로 뺀다(확장자 .md 하나). 파일 이름을 하나씩 예외로 박으면
 *     다음에 생기는 README 를 또 못 거른다. */

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const shaArg = args.includes('--sha') ? args[args.indexOf('--sha') + 1] : null;

const ssh = (cmd) =>
  execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-i', SSH_KEY, SSH_HOST, cmd],
               { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });

const git = (...a) => execFileSync('git', a, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });

/* ── ① 서버가 «주장»하는 커밋 ─────────────────────────────── */
const marker = (shaArg || ssh(`cat ${DOCROOT}/DEPLOY_SHA 2>/dev/null || echo MISSING`)).trim();
if (!marker || marker === 'MISSING') {
  console.error('✗ DEPLOY_SHA 가 없다. 마커 없이 배포된 서버다 — 무엇이 올라가 있는지 알 길이 없다.');
  process.exit(2);
}

let full;
try { full = git('rev-parse', '--verify', `${marker}^{commit}`).trim(); }
catch { console.error(`✗ DEPLOY_SHA=${marker} 가 이 레포에 «없는 커밋»이다. fetch 했는지 확인해라.`); process.exit(2); }

/* ── ② 그 커밋이 «가져야 할» 블롭 해시 ────────────────────── */
const want = new Map();
for (const line of git('ls-tree', '-r', full).split('\n')) {
  if (!line) continue;
  const [meta, path] = line.split('\t');
  const [, type, hash] = meta.split(/\s+/);
  if (type !== 'blob') continue;
  if (EXCLUDE.test(path) || !INCLUDE.test(path)) continue;
  want.set(path, hash);
}

/* ── ③ 서버 파일의 «실제» 블롭 해시 ───────────────────────────
 *   ⚠️파일명에 공백이 있을 수 있어 개행 구분으로 받는다. 서버에서 계산하고 값만 가져온다. */
const paths = [...want.keys()];
const remote = ssh(
  `cd ${DOCROOT} && for f in ${paths.map(p => `'${p.replace(/'/g, `'\\''`)}'`).join(' ')}; do ` +
  `if [ -f "$f" ]; then ` +
  `  s=$(wc -c < "$f"); ` +
  `  h=$({ printf 'blob %d\\0' "$s"; cat "$f"; } | sha1sum | cut -d' ' -f1); ` +
  `  printf '%s %s\\n' "$h" "$f"; ` +
  `else printf 'MISSING %s\\n' "$f"; fi; done`
);

const have = new Map();
for (const line of remote.split('\n')) {
  if (!line.trim()) continue;
  const i = line.indexOf(' ');
  have.set(line.slice(i + 1), line.slice(0, i));
}

/* ── ④ 대조 ──────────────────────────────────────────────── */
const mismatch = [], missing = [];
for (const [path, hash] of want) {
  const got = have.get(path);
  if (got === undefined || got === 'MISSING') { missing.push(path); continue; }
  if (got !== hash) mismatch.push({ path, want: hash.slice(0, 12), have: got.slice(0, 12) });
}

/* ★어긋난 파일이 «어느 커밋»의 것인지까지 짚어 준다 — 「몇 커밋 뒤처졌나」가 이 건의 무게였다 */
let behindNote = '';
if (mismatch.length) {
  try {
    const head = git('rev-parse', 'origin/main').trim();
    const n = git('rev-list', '--count', `${full}..${head}`).trim();
    if (n !== '0') behindNote = `  (DEPLOY_SHA 는 origin/main 보다 ${n} 커밋 뒤다)`;
  } catch { /* origin/main 이 없어도 검사는 계속한다 */ }
}

const ok = mismatch.length === 0 && missing.length === 0;
if (asJson) {
  console.log(JSON.stringify({ ok, marker: full, checked: want.size, mismatch, missing }, null, 2));
} else {
  console.log(`DEPLOY_SHA = ${full.slice(0, 7)}  ·  대조 ${want.size}개`);
  if (ok) console.log('✓ 마커와 실제 파일이 일치한다.');
  else {
    if (mismatch.length) {
      console.log(`\n✗ 내용이 «다른» 파일 ${mismatch.length}개${behindNote}`);
      for (const m of mismatch) console.log(`    ${m.path}\n      마커: ${m.want} / 실제: ${m.have}`);
    }
    if (missing.length) {
      console.log(`\n✗ 서버에 «없는» 파일 ${missing.length}개`);
      for (const p of missing) console.log(`    ${p}`);
    }
    console.log('\n⚠️DEPLOY_SHA 가 라이브 내용을 «잘못» 말하고 있다.');
    console.log('  「지금 뭐가 올라가 있나」에 답할 때 이 값을 믿으면 안 된다.');
  }
}
process.exit(ok ? 0 : 1);
