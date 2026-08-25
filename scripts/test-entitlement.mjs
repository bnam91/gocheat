import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
const require = createRequire(import.meta.url);
const HP = '/Users/a1/github/hompage_app';
const { MongoMemoryServer } = require('mongodb-memory-server');
const { MongoClient } = require('mongodb');
const E = require(path.join(HP,'api/_lib/entitlements.js'));

let n=0; const ok=(c,w)=>{if(!c)throw new Error('FAIL — '+w);n++;console.log('  ✓ '+w);};
const mem = await MongoMemoryServer.create();
const cli = await MongoClient.connect(mem.getUri());
const db = cli.db('goditor_license_dev');
const users = db.collection('users');
const get = () => users.findOne({email:'a@b.c'});
const run = (args) => spawnSync(process.execPath,[path.join(HP,'scripts/promote-entitlement.mjs'),...args],
  {env:{...process.env,MONGO_URI:mem.getUri()},encoding:'utf8'});   // 기본 _dev DB

try {
  // 가입 상태 모사: 세 앱 event_free + 구필드
  await users.insertOne({email:'a@b.c',verified:true,plan:'event_free',accessUntil:new Date('2026-12-31'),
    entitlements:E.eventEntitlements(new Date('2026-12-31'))});

  console.log('[1] dry-run 은 안 쓴다');
  let r=run(['--email','a@b.c','--app','godiv','--until','2027-08-15']);
  ok(/드라이런/.test(r.stdout) && (await get()).entitlements.godiv.plan==='event_free','dry-run 뒤 변화 없음');

  console.log('[2] 승격 apply — godiv «만» paid, 나머지·구필드 불변 (교차오염 0)');
  r=run(['--email','a@b.c','--app','godiv','--until','2027-08-15','--apply']);
  let u=await get();
  ok(u.entitlements.godiv.plan==='paid','godiv=paid');
  ok(u.entitlements.goditor.plan==='event_free' && u.entitlements.goshot.plan==='event_free','goditor·goshot 그대로 free');
  ok(u.plan==='event_free','★구필드 plan 불변(additive)');
  ok(u.accessUntil.getTime()===new Date('2026-12-31').getTime(),'★구필드 accessUntil 불변');
  ok(u.entitlements.godiv.source.startsWith('manual'),'source 기록');

  console.log('[3] effectiveFor 가 앱별로 갈리나 (승격 후)');
  ok(E.effectiveFor(u,'godiv').plan==='paid' && E.isPaidPlan(E.effectiveFor(u,'godiv').plan),'godiv 유효=paid');
  ok(E.effectiveFor(u,'goditor').plan==='event_free','goditor 유효=free (교차오염 0)');
  ok(E.effectiveFor(u,'godiv').until && new Date(E.effectiveFor(u,'godiv').until).getFullYear()===2027,'godiv until=2027');

  console.log('[4] 멱등 — 같은 승격 두 번');
  r=run(['--email','a@b.c','--app','godiv','--until','2027-08-15','--apply']);
  ok(/멱등|아무것도 안/.test(r.stdout),'두 번째는 no-op(멱등)');
  ok((await db.collection('entitlement_audit').countDocuments())===1,'감사로그 1건(멱등이라 안 늘어남)');

  console.log('[5] --forever = 무기한(until:null), far-future 매직넘버 아님');
  r=run(['--email','a@b.c','--app','goshot','--forever','--apply']);
  u=await get();
  ok(u.entitlements.goshot.plan==='paid' && u.entitlements.goshot.until===null,'goshot=paid·until=null(무기한)');
  ok(E.effectiveFor(u,'goshot').until===null,'effectiveFor 무기한 통과');

  console.log('[6] 기간 단축은 --force 없이 거부');
  r=run(['--email','a@b.c','--app','godiv','--until','2027-01-01','--apply']);
  ok(/거부/.test(r.stdout+r.stderr) && new Date((await get()).entitlements.godiv.until).getFullYear()===2027 && (await get()).entitlements.godiv.until,'단축 거부');
  // 정확히 2027-08-15 유지 확인
  ok(new Date((await get()).entitlements.godiv.until).getMonth()===7,'godiv until 그대로(8월)');

  console.log('[7] 리뷰크롤러는 이 도구 대상 아님');
  r=run(['--email','a@b.c','--app','reviewcrawler','--apply']);
  ok(/모르는 앱|대상 아님/.test(r.stdout+r.stderr),'reviewcrawler 거부');

  console.log('[8] 무기한→기간 축소는 --force 없이 거부');r=run(['--email','a@b.c','--app','goshot','--until','2027-06-01','--apply']);ok(/거부/.test(r.stdout+r.stderr) && (await get()).entitlements.goshot.until===null,'무기한→기간 축소 거부(goshot 무기한 유지)');console.log(`\nPASS — ③ 실 DB 검증 ${n}항목`);
} catch(e){ console.error('\n'+e.message); process.exitCode=1; }
finally { await cli.close(); await mem.stop(); }
