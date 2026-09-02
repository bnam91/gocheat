/**
 * 마이페이지 — 계정 정보·등급·이용 기한 표시
 *
 * 2026-09-02: HTML 안에 있던 것을 파일로 뺐다.
 *   HTML 은 no-cache 라 인라인이면 페이지를 볼 때마다 다시 내려받는다.
 * ★<body> 끝에서 불린다 — 문서가 이미 그려진 뒤다.
 */
(function () {
// 로그인 상태 — login.html 이 넣어 둔 키를 그대로 쓴다
var email = null, plan = null, until = null;
try {
  email = sessionStorage.getItem('sms_email');
  plan  = sessionStorage.getItem('sms_plan');
  until = sessionStorage.getItem('sms_until');
} catch (e) {}

if (!email) { document.getElementById('mp-guest').style.display = 'block'; return; }
document.getElementById('mp-body').style.display = 'block';
var navLogin = document.getElementById('nav-login');
if (navLogin) { navLogin.textContent = '마이페이지'; navLogin.href = 'mypage.html'; }

// ★표시명과 코드값을 가른다 — 서버는 코드값을 주고 화면은 표시명을 쓴다.
//   beta 는 등급이 아니라 «기간»이다. event_free 는 옛 서버 값으로 뜻이 같다.
var PLAN_LABEL = { beta:'BETA', event_free:'BETA', free:'FREE', starter:'STARTER', pro:'PRO', promax:'PRO MAX' };
var code = String(plan || '').toLowerCase();
document.getElementById('mp-plan').textContent = PLAN_LABEL[code] || (code ? code.toUpperCase() : 'FREE');
document.getElementById('mp-email').textContent = email;

var untilTxt = '';
if (until) {
  var d = new Date(until);
  if (!isNaN(d)) {
    var left = Math.ceil((d - Date.now()) / 86400000);
    // ★toISOString() 은 UTC 다 — 2026-12-31T23:59:59Z 를 그렇게 찍으면 한국 사용자에게
    //   「2026-12-31 까지」로 «하루 이르게» 보인다(실제 만료는 KST 2027-01-01).
    //   바로 아래 kstDate() 가 이미 있었는데 주문일(77행)만 쓰고 여기만 빠져 있었다.
    untilTxt = kstDate(d) + ' 까지' + (left >= 0 && left <= 30 ? ' · ' + left + '일 남음' : '');
  }
}
if (code === 'beta' || code === 'event_free') {
  untilTxt = (untilTxt || '') + (untilTxt ? ' · ' : '') + '베타테스트가 끝나면 FREE로 전환돼요';
}
document.getElementById('mp-until').textContent = untilTxt;

// 탭
var tabs = document.querySelectorAll('.mp-tabs button');
function showPane(name) {
  var target = document.getElementById('pane-' + name);
  if (!target) return false;                       // 없는 이름이면 «아무것도 안 한다» — 빈 화면을 만들지 않는다
  Array.prototype.forEach.call(tabs, function (x) {
    x.classList.toggle('on', x.getAttribute('data-pane') === name);
  });
  Array.prototype.forEach.call(document.querySelectorAll('.mp-pane'), function (p) { p.classList.remove('on'); });
  target.classList.add('on');
  return true;
}
Array.prototype.forEach.call(tabs, function (b) {
  b.addEventListener('click', function () { showPane(b.getAttribute('data-pane')); });
});

// ★해시로 «바로 그 탭»을 열 수 있어야 한다. order.html 의 「내 주문 보기 →」가
//   mypage.html#orders 로 보내는데, 전에는 click 만 듣고 hash 를 안 읽어서
//   결제 직후 그 버튼이 «아무 데도 안 가는» 상태였다(2026-09-02 QA 발견).
function applyHash() {
  var h = (location.hash || '').replace(/^#/, '');
  if (h) showPane(h);
}
applyHash();
window.addEventListener('hashchange', applyHash);

// 주문 내역 — ★프론트만이다. order.html 이 남긴 화면 확인용 기록을 읽는다.
var orders = [];
try { orders = JSON.parse(sessionStorage.getItem('sms_orders') || '[]'); } catch (e) {}
// ★연동 여부를 «표를 그리기 전»에 알아야 상태 문구를 정할 수 있다.
fetch('data/business.json').then(function (r) { return r.ok ? r.json() : null; })
  .catch(function () { return null; })
  .then(function (b) { window.__smsDummy = !b || b.bankIsDummy !== false; renderOrders(); });

function renderOrders() {
if (!orders.length) {
  document.getElementById('mp-ord-empty').style.display = 'block';
} else {
  document.getElementById('mp-ord-table').style.display = 'table';
  // ★UL-002: 연동 여부는 business.json 한 곳에서만 판단한다(주문 화면과 같은 근거).
  document.getElementById('mp-dummy').style.display    = window.__smsDummy ? 'block' : 'none';
  document.getElementById('mp-ord-note').style.display = window.__smsDummy ? 'none'  : 'block';
  document.getElementById('mp-ord-body').innerHTML = orders.map(function (o) {
    // ★NEW-08: 연동 전인데 「입금 확인 중」이라 적으면 실제로 접수된 것처럼 읽힌다.
    //   CTA 도 「주문 화면 미리보기」라 말해놓고 상태만 진짜처럼 굴면 앞뒤가 안 맞는다.
    var cls = o.status === 'paid' ? 'done' : 'wait';
    var txt = o.status === 'paid' ? '완료' : (window.__smsDummy ? '미리보기' : '입금 확인 중');
    // ★NEW-04: toISOString 은 UTC 다 — 00~09시 KST 주문이 전부 «어제»로 찍혔다.
    //   login.html 은 이미 한국시간으로 고정돼 있는데 주문 쪽만 안 따라갔다.
    var day = '';
    try { var d = new Date(o.at); if (!isNaN(d)) day = kstDate(d); } catch (e) {}
    return '<tr><td class="mono">' + esc(o.orderNo) + '</td><td>' + esc(o.planName)
         + '</td><td>' + esc(o.price) + '</td><td>' + esc(o.depositor || '—')
         + '</td><td>' + esc(day || '—')
         + '</td><td><span class="mp-pill ' + cls + '">' + txt + '</span></td></tr>';
  }).join('');
}
}

// 다운로드
fetch('data/downloads.json').then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
  var g = (d && d.goditor) || {};
  document.getElementById('mp-dl-ver').textContent = g.version ? ('GODITOR ' + g.version) : '';
  var NAME = { 'mac-arm64': '맥 (Apple Silicon)', 'mac-intel': '맥 (Intel)', 'win': '윈도우' };
  var html = '';
  Object.keys(NAME).forEach(function (k) {
    if (g[k]) html += '<a href="' + esc(g[k]) + '" target="_blank" rel="noopener">'
                    + '<span>' + NAME[k] + '</span><span class="arw">→</span></a>';
  });
  document.getElementById('mp-dl-links').innerHTML = html || '<p class="dim">다운로드 정보를 불러오지 못했어요.</p>';
}).catch(function () {});

document.getElementById('mp-logout').addEventListener('click', function () {
  // ★NEW-01: 여기가 R1 에서 유출을 재현한 «바로 그 경로»인데 login.html 만 고쳤었다.
  //   그 사이 UL-012(입금자 실명 열)·UL-004(sms_last_order)가 들어가 «유출 정보가 늘었다».
  //   ⇒ 키를 하나씩 지우지 않는다. sms_ 접두를 전부 지운다.
  try {
    Object.keys(sessionStorage).filter(function (k) { return k.indexOf('sms_') === 0; })
          .forEach(function (k) { sessionStorage.removeItem(k); });
    sessionStorage.removeItem('goditor_after_login');
  } catch (e) {}
  location.href = 'login.html';
});

// 한국시간 기준 YYYY-MM-DD. 보는 사람 시간대에 따라 날짜가 달라지면 안 된다.
function kstDate(d) {
  return new Date(d.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
    return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[c];
  });
}
  })();
