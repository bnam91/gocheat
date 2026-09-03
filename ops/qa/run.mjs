/**
 * 홈페이지 QA 러너 — «렌즈별로» 전 페이지를 훑는다.
 *
 * 쓰는 법 (맥에서)
 *   node ops/qa/run.mjs                 → 전 렌즈
 *   node ops/qa/run.mjs guest nojs      → 그 렌즈만
 *   QA_PORT=9407 QA_BASE=https://blacksheepwall.kr node ops/qa/run.mjs
 *
 * ⚠️크롬을 «먼저» 띄워야 한다(현빈 실사용 PC라 화면 밖·headless 로):
 *   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new \
 *     --remote-debugging-port=9407 --user-data-dir=/tmp/qa-profile \
 *     --window-position=-2400,0 --no-first-run --no-default-browser-check about:blank &
 *
 * ⛔쓰고 나면 «반드시» 죽인다: pkill -f 'remote-debugging-port=9407' && rm -rf /tmp/qa-profile
 */
import { readFileSync } from 'node:fs';
import { WAIT, PROBE, MIN_SETTLE } from './probe.mjs';

const PORT = process.env.QA_PORT || 9407;
const BASE = process.env.QA_BASE || 'https://blacksheepwall.kr';
const CFG  = JSON.parse(readFileSync(new URL('./lenses.json', import.meta.url), 'utf8'));
const want = process.argv.slice(2);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function http(p, method) {
  const r = await fetch(`http://127.0.0.1:${PORT}${p}`, { method: method || 'GET' });
  return r.json();
}
class Sess {
  constructor(ws) { this.ws = ws; this.id = 0; this.pend = new Map(); this.evs = []; }
  static async open(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const s = new Sess(ws);
    ws.onmessage = (m) => { const d = JSON.parse(m.data);
      if (d.id && s.pend.has(d.id)) { const { res, rej } = s.pend.get(d.id); s.pend.delete(d.id);
        d.error ? rej(new Error(JSON.stringify(d.error))) : res(d.result); }
      else s.evs.push(d); };
    return s;
  }
  send(method, params = {}) { const id = ++this.id;
    return new Promise((res, rej) => { this.pend.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  close() { this.ws.close(); }
}

const tab = await http('/json/new?about:blank', 'PUT');   // ★GET 은 최신 크롬이 거부한다
const s = await Sess.open(tab.webSocketDebuggerUrl);
for (const d of ['Page', 'Network', 'Runtime', 'Log']) await s.send(d + '.enable');
await s.send('Network.setCacheDisabled', { cacheDisabled: true });   // ★캐시버스터 사고를 검사 단계에서 막는다

const ev = async (e) => (await s.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result.value;
async function go(url) {
  await s.send('Page.navigate', { url });
  for (let i = 0; i < 80; i++) { await sleep(120); if (await ev('document.readyState') === 'complete') break; }
  await sleep(MIN_SETTLE);                       // ★지연 시작 애니메이션을 «시작시키고» 기다린다
  for (let i = 0; i < 10; i++) { if (!(await ev(WAIT))) break; await sleep(150); }
}

// ── 렌즈용 계정 준비 ────────────────────────────────────────────────
async function api(path, body) {
  const r = await fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return r.json().catch(() => ({}));
}
const stamp = Date.now().toString().slice(-6);
async function makeUser(lens) {
  const email = `qa-${lens.id}-${stamp}@goya.test`, pw = `QaRun!${stamp}`;
  await api('/api/license/signup', { email, password: pw,
    profile: { name: 'QA' + lens.id, phone: '01000000000' },
    consents: { terms: true, privacy: true, marketing: false } });
  for (const a of (lens.apps || [])) await api('/api/license/login', { email, password: pw, app: a });
  return { email, pw };
}

const lenses = CFG.lenses.filter((l) => !want.length || want.includes(l.id));
const rows = [];
console.log(`\n══ 홈페이지 QA · 렌즈 ${lenses.length} × 페이지 ${CFG.pages.length} × ${CFG.viewports.length}폭 × ${CFG.themes.length}테마 ══`);

for (const lens of lenses) {
  let acc = null;
  if (lens.login) acc = await makeUser(lens);
  for (const vp of CFG.viewports) {
    for (const th of CFG.themes) {
      await s.send('Emulation.setDeviceMetricsOverride', { width: vp.w, height: vp.h, deviceScaleFactor: 1, mobile: vp.w < 500 });
      await s.send('Emulation.setScriptExecutionDisabled', { value: !!lens.disableJs });
      if (lens.throttle) await s.send('Network.emulateNetworkConditions',
        { offline: false, latency: 400, downloadThroughput: 400 * 1024 / 8, uploadThroughput: 400 * 1024 / 8 });
      // 테마·로그인 심기 (JS 를 끈 렌즈에서는 못 한다 — 그건 «비로그인·기본테마»로 본다)
      if (!lens.disableJs) {
        await go(BASE + '/');
        await ev(`try{localStorage.setItem('sms_theme',${JSON.stringify(th)})}catch(e){}`);
        if (acc) {
          await go(BASE + '/login.html');
          await ev(`(()=>{const e=document.getElementById('email'),p=document.getElementById('password');
            const d=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
            d.call(e,${JSON.stringify(acc.email)}); e.dispatchEvent(new Event('input',{bubbles:true}));
            d.call(p,${JSON.stringify(acc.pw)}); p.dispatchEvent(new Event('input',{bubbles:true}));
            document.querySelector('#login-form button[type=submit],#login-submit').click();})()`);
          for (let i = 0; i < 80; i++) { await sleep(250); if (await ev('location.pathname') === '/') break; }
          if (lens.breakToken) await ev(`sessionStorage.setItem('sms_token','broken-'+Date.now())`);
          if (lens.until) await ev(`sessionStorage.setItem('sms_until', new Date(Date.now()+${lens.until}*864e5).toISOString())`);
        }
      }
      for (const p of CFG.pages) {
        s.evs.length = 0;
        await go(BASE + p);
        const r = await ev(PROBE);
        const errs = s.evs.filter((d) => d.method === 'Log.entryAdded' && d.params.entry.level === 'error')
          .map((d) => d.params.entry.text.slice(0, 70));
        const exc = s.evs.filter((d) => d.method === 'Runtime.exceptionThrown')
          .map((d) => (d.params.exceptionDetails.exception?.description || '').slice(0, 70));
        const issues = [];
        if (r.invisible.length)   issues.push('안보임: ' + r.invisible.join(','));
        if (r.offscreen.length)   issues.push('화면밖: ' + r.offscreen.join(','));
        if (r.covered.length)     issues.push('가려짐: ' + r.covered.join(','));
        if (r.deadLinks.length)   issues.push('죽은링크: ' + r.deadLinks.join(','));
        if (r.lowContrast.length) issues.push('대비낮음: ' + r.lowContrast.join(','));
        if (r.hScroll)            issues.push('가로스크롤');
        if (r.bodyLen < 60)       issues.push('본문이 거의 없음(' + r.bodyLen + '자)');
        [...errs, ...exc].forEach((e) => issues.push('콘솔: ' + e));
        if (issues.length) rows.push({ lens: lens.name, vp: vp.name, th, page: p, issues });
      }
      if (lens.throttle) await s.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
      await s.send('Emulation.setScriptExecutionDisabled', { value: false });
      if (lens.disableJs) break;   // JS 없는 렌즈는 테마를 못 바꾼다 — 한 번만 본다
    }
    if (lens.disableJs) break;
  }
  const n = rows.filter((x) => x.lens === lens.name).length;
  console.log(`  ${n ? '⛔' : '✅'} ${lens.name.padEnd(16)} ${n ? n + '건' : '이상 없음'}`);
}

if (rows.length) {
  console.log('\n── 상세 ──');
  for (const r of rows) console.log(`  [${r.lens}/${r.th}/${r.vp}] ${r.page}\n      ${r.issues.join('\n      ')}`);
}
console.log(`\n  총 ${rows.length}건`);
s.close();
process.exit(0);
