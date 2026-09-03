/**
 * 마이페이지 — 계정 정보·등급·이용 기한 표시
 *
 * 2026-09-02: HTML 안에 있던 것을 파일로 뺐다.
 *   HTML 은 no-cache 라 인라인이면 페이지를 볼 때마다 다시 내려받는다.
 * ★<body> 끝에서 불린다 — 문서가 이미 그려진 뒤다.
 */
(function () {
// 로그인 상태 — login.html 이 넣어 둔 키를 그대로 쓴다
// ★등급·기한은 «읽지 않는다» — 화면에서 걷었기 때문이다(현빈 2026-09-03).
//   등급은 앱별(users.apps.<앱>.tier)이고 제자리는 앱 카드다. 여기서 계정 등급을 다시 읽으면
//   언젠가 또 그리게 된다. 쓰지 않는 값은 «가져오지도 않는다».
var email = null;
try { email = sessionStorage.getItem('sms_email'); } catch (e) {}

if (!email) { document.getElementById('mp-guest').style.display = 'block'; return; }
document.getElementById('mp-body').style.display = 'block';
// ★주문 표의 «상품명·금액»은 data/apps.json 이 단일 출처다 — 여기 값을 박아 두면
//   요금이 바뀔 때 마이페이지만 옛 금액을 보여준다(실제로 겪은 병이다).
var PLAN_NAME = {}, PRICE_TXT = {};
fetch('data/apps.json?v=20260904m').then(function (r) { return r.ok ? r.json() : null; })
  .then(function (j) {
    // apps.json 은 «앱 배열»이고 각 앱이 plans 를 가진다. 앱을 돌며 요금제를 모은다.
    (Array.isArray(j) ? j : []).forEach(function (app) {
      (app && Array.isArray(app.plans) ? app.plans : []).forEach(function (p) {
        if (!p || !p.id) return;
        PLAN_NAME[p.id] = p.name || p.id;
        PRICE_TXT[p.id] = p.price || '';
      });
    });
    renderOrders();
  }).catch(function () {});

// ★상단바는 nav-auth.js 가 맡는다(2026-09-03).
//   전에는 여기서 「로그인」을 «무조건» 「마이페이지」로 바꿨는데, 그러면 마이페이지 안에
//   «자기 자신을 가리키는 링크»가 남고, 정작 «로그아웃할 문»이 없었다.
//   ⇒ nav-auth.js 가 로그인 상태를 보고 이 칸을 「로그아웃」으로 만든다.

document.getElementById('mp-email').textContent = email;

// ── 앱별 이용 현황 · 이름·연락처 ─────────────────────────────────
// ★서버에서 «한 번에» 받아온다(api/license/me). sessionStorage 에 없는 값(이름·연락처·사용 기록)이라
//   화면이 스스로 지어낼 수 없다. 못 받으면 «비워 두지» 말고 그 사실을 말한다.
(function loadMe() {
  var box = document.getElementById('mp-apps');
  var token = null;
  try { token = sessionStorage.getItem('sms_token') || ''; } catch (e) {}
  if (!token) { box.innerHTML = '<div class="mp-empty mp-empty-err">'
      + '<p class="mp-empty-title">이용 현황을 불러오려면 다시 로그인해 주세요</p>'
      + '<a class="mp-empty-cta" href="login.html?next=mypage">로그인하러 가기 →</a></div>'; return; }

  var esc = function (t) { return String(t == null ? '' : t)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); };
  // ★날짜는 «한국 시간»으로 찍는다 — 이 파일 아래 kstDate 와 같은 이유다(UTC 로 찍으면 하루 어긋난다).
  var fmt = function (iso) {
    if (!iso) return null;
    var d = new Date(iso); if (isNaN(d)) return null;
    var k = new Date(d.getTime() + 9 * 3600e3);
    return k.getUTCFullYear() + '-' + String(k.getUTCMonth()+1).padStart(2,'0') + '-' + String(k.getUTCDate()).padStart(2,'0');
  };

  fetch('/api/license/me', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionToken: token }),
  }).then(function (r) { return r.json().catch(function () { return {}; }); })
    .then(function (d) {
      if (!d || !d.ok) {
        box.innerHTML = '<div class="mp-empty mp-empty-err">'
          + '<p class="mp-empty-title">이용 현황을 불러오지 못했어요</p>'
          + '<p class="mp-empty-desc">새로고침해 주세요.</p></div>';
        return;
      }
      // 이름·연락처 — 확장 가입 «전»에 만들어진 계정은 값이 없다. 빈칸이 아니라 «없다»고 말한다.
      var nm = document.getElementById('mp-name');
      var ph = document.getElementById('mp-phone');
      if (nm) nm.textContent = (d.profile && d.profile.name) || '등록 안 됨';
      if (ph) ph.textContent = (d.profile && d.profile.phone)
        ? String(d.profile.phone).replace(/^(\d{3})(\d{3,4})(\d{4})$/, '$1-$2-$3')
        : '등록 안 됨';

      // ★서버가 준 주문으로 «갈아끼운다». 세션 값은 여기서 버린다.
      if (Array.isArray(d.orders)) {
        orders = d.orders.map(function (o) {
          return { orderNo: o.orderNo, planName: PLAN_NAME[o.plan] || o.plan || '—',
                   price: PRICE_TXT[o.plan] || '—', depositor: o.depositor,
                   status: o.status === 'paid' ? 'paid' : 'awaiting_deposit', at: o.at };
        });
        renderOrders();
      }

      box.innerHTML = (d.apps || []).map(function (a) {
        // ★★「사용 기록을 남기지 않아요」를 걷었다(현빈 2026-09-03) — 그건 «우리 사정»이지
        //   사용자가 알 일이 아니다. 화면에 우리 구현 사정을 적지 않는다.
        // ★대신 «있는 사실»을 쓴다. 실행 로그(lastUsedAt)가 있으면 그걸,
        //   없으면 «마지막 로그인»을 쓴다 — 앱은 켤 때 라이선스를 검증하므로 사실상 마지막 사용 시각이고,
        //   서버는 그 값을 이미 로그인 때 쓰고 있다(추가 부담 0).
        //   ⛔둘을 같은 이름으로 부르지 않는다 — 「사용」과 「로그인」은 다른 사실이다.
        var used = a.lastUsedAt
          ? '마지막 사용 <b>' + esc(fmt(a.lastUsedAt)) + '</b>' + (a.uses ? ' · ' + a.uses + '회' : '')
          : (a.lastLoginAt
              ? '마지막 로그인 <b>' + esc(fmt(a.lastLoginAt)) + '</b>'
              : '<span class="mp-app-dim">기록 없음</span>');
        // ★번들이 있으면 «언제부터 쓰는지»가 있다. 그게 「이용 중」이라는 말의 근거다.
        // ⛔단, 앞에 찍은 날짜와 «같은 날»이면 안 쓴다 — 「마지막 로그인 09-03 · 09-03부터」는
        //   같은 값을 두 번 말하는 것이고, 오늘 처음 쓴 사람에게는 «전부» 그렇게 보인다.
        var lastShown = a.lastUsedAt ? fmt(a.lastUsedAt) : (a.lastLoginAt ? fmt(a.lastLoginAt) : null);
        var sinceTxt  = a.firstSeenAt ? fmt(a.firstSeenAt) : null;
        var since = (sinceTxt && sinceTxt !== lastShown)
          ? '<span class="mp-app-dim"> · ' + esc(sinceTxt) + '부터</span>' : '';
        // 결제방식은 «있을 때만» 적는다. 없는데 「무료」라고 쓰면 유료 전환 뒤 거짓이 된다.
        var pay = a.payment ? '<p class="mp-app-note">결제 ' + esc(a.payment) + '</p>' : '';
        // ★최고 등급이면 「등급 올리기」를 안 그린다 — 눌러도 올릴 게 없는 링크는 거짓말이다.
        var up = a.canUpgrade ? '<a href="pricing.html" class="mp-app-up">등급 올리기 →</a>' : '';
        // ★★등급별 배지(현빈 2026-09-03: 「라이트모드에서도 별도 등급별 벳지가 있으면 좋겠는데」).
        //   ★«색»이 아니라 «무게»로 가른다 — 등급이 오를수록 테가 진해지고, 최상위는 «채운다».
        //     색으로만 가르면 ⑴색각 이상에서 안 갈리고 ⑵두 테마에 각각 색을 정해야 하는데
        //     우리 팔레트엔 그만한 색이 없어 «새 색»을 지어내야 한다. 무게는 토큰 세 개로 끝난다.
        //   ★앱마다 등급표가 다르므로 «앱 이름»이 아니라 «번호»로 판정한다(tiers.json 과 같은 축).
        //     ⛔별칭(label)으로 판정하지 마라 — 이름을 바꾸는 순간 배지가 바뀐다.
        var tn = Number(a.tier);
        var badge = a.staff ? ' mp-app-plan-staff'          // 88·99 — 구매로 도달할 수 없는 자리
          : !isFinite(tn) || tn <= 0 ? ' mp-app-plan-none'  // GUEST
          : tn === 1 ? ' mp-app-plan-beta'                  // 무료 이용 기간
          : a.canUpgrade ? ' mp-app-plan-paid'              // 유료지만 위가 남았다
          : ' mp-app-plan-top';                             // 그 앱의 최상위
        return '<div class="mp-app">'
          + '<div class="mp-app-top">'
          +   '<span class="mp-app-name">' + esc(a.name) + '</span>'
          +   '<span class="mp-app-kind">' + (a.kind === 'service' ? 'SERVICE' : 'PRODUCT') + '</span>'
          + '</div>'
          + '<span class="mp-app-plan' + badge + '">' + esc(a.label) + '</span>'
          + pay
          + '<p class="mp-app-used">' + used + since + '</p>'
          + up
          + '</div>';
        // ★빈 상태도 «카드»다(현빈 2026-09-03). 맨 문장은 「덜 만들었다」로 읽힌다.
      }).join('') || '<div class="mp-empty">'
          + '<p class="mp-empty-title">아직 이용 중인 서비스가 없어요</p>'
          + '<p class="mp-empty-desc">앱에서 이 계정으로 로그인하면 여기에 나타납니다.</p>'
          + '<a class="mp-empty-cta" href="/#hero-apps">앱 둘러보기 →</a>'
          + '</div>';
    })
    .catch(function () {
      box.innerHTML = '<div class="mp-empty mp-empty-err">'
          + '<p class="mp-empty-title">이용 현황을 불러오지 못했어요</p>'
          + '<p class="mp-empty-desc">새로고침해 주세요.</p></div>';
    });
})();

// ★계정 등급·기한 표시를 «걷었다»(현빈 2026-09-03). 등급은 «앱별»이고 제자리는 앱 카드다.
//   ⛔여기서 다시 그리지 마라 — 같은 값을 두 곳에서 그리면 앱별 등급이 갈리는 날 한쪽이 거짓이 된다.

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
// ★★주문은 «서버»에서 온다(2026-09-03). sessionStorage 는 «주문 직후 한 번»만 쓰는 임시 통로다.
//   전에는 이것만 봐서 탭을 닫으면 주문이 사라졌고, 화면은 그걸 「이 탭에서만 유지됩니다」라고
//   고백했다 — 한계가 아니라 «버그를 문구로 덮은 것»이었다. 이제 /api/license/me 가 같이 준다.
//   ⛔둘을 합치지 마라 — 서버 응답이 오면 «그것이 정답»이다. 세션 값은 서버가 답하기 전의 임시 표시다.
var orders = [];
try { orders = JSON.parse(sessionStorage.getItem('sms_orders') || '[]'); } catch (e) {}
// ★연동 여부를 «표를 그리기 전»에 알아야 상태 문구를 정할 수 있다.
fetch('data/business.json?v=20260904m').then(function (r) { return r.ok ? r.json() : null; })
  .catch(function () { return null; })
  .then(function (b) { window.__smsDummy = !b || b.bankIsDummy !== false; renderOrders(); });

function renderOrders() {
  if (!document.getElementById('mp-ord-body')) return;   // 화면이 아직 없으면 아무것도 안 한다
// ★★두 갈래가 «서로의 상태를 되돌려야» 한다.
//   renderOrders 는 여러 번 불린다(세션 값 → 서버 응답 → 요금표 도착). 한쪽만 켜고 끄지 않으면
//   먼저 그린 빈 카드가 표와 «같이» 남는다(2026-09-03 실제로 그랬다).
//   ⇒ 각 갈래가 «자기 것을 켜고 남의 것을 끈다». 한 줄이라도 빠지면 잔상이 생긴다.
if (!orders.length) {
  // ⛔★display 를 «인라인으로 박지 마라» — CSS 가 인라인을 못 이긴다.
  //   여기 'block' 을 넣었더니 .mp-empty 의 display:flex 가 죽고 align-items:center 가 무시돼
  //   설명 문단(max-width:34ch)이 카드 왼쪽에 붙었다. 글자만 가운데라 «가운데인 척»했다.
  //   ★이 파일 CSS 주석 66행에 «이미 적어둔» 함정을 새 자리에서 다시 밟았다(2026-09-03).
  //   ⇒ 빈 문자열로 «인라인을 걷어» CSS 가 정하게 한다. 숨길 때만 'none' 을 쓴다.
  document.getElementById('mp-ord-empty').style.display = '';
  document.getElementById('mp-ord-table').style.display = 'none';
  document.getElementById('mp-dummy').style.display    = 'none';
  document.getElementById('mp-ord-note').style.display = 'none';
} else {
  document.getElementById('mp-ord-empty').style.display = 'none';
  document.getElementById('mp-ord-table').style.display = 'table';
  // ★「탭 닫으면 사라진다」 경고는 «없앴다» — 주문을 서버에서 읽게 고쳐서 사라질 일이 없다.
  //   그 요소를 켜던 코드도 같이 걷는다(없는 id 를 부르는 코드는 다음 사람을 헷갈리게 한다).
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
// ★다운로드 탭을 없앴다(현빈 2026-09-03) — 여기서 downloads.json 을 읽던 코드도 같이 걷었다.
//   ⛔화면을 지우고 데이터 코드를 남기면 «아무도 안 보는 fetch»가 매 방문마다 돈다.

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

// ── 비밀번호 «변경» (현빈 2026-09-02) ──────────────────────────────────────
// ★로그인한 사람은 즉시 바꿀 수 있어야 한다. 전에는 find-password.html 로 보내서
//   «본인임이 이미 증명된» 사람이 「잊었다」 흐름을 다시 타야 했다.
(function () {
  var toggle = document.getElementById('mp-pw-toggle');
  var form   = document.getElementById('mp-pw-form');
  if (!toggle || !form) return;                 // 마크업이 없으면 조용히 아무것도 안 한다

  var msgEl  = document.getElementById('mp-pw-msg');
  var submit = document.getElementById('mp-pw-submit');
  var cur = document.getElementById('mp-pw-cur');
  var nw  = document.getElementById('mp-pw-new');
  var nw2 = document.getElementById('mp-pw-new2');

  function say(text, ok) {
    msgEl.textContent = text;
    msgEl.className = 'signup-msg ' + (ok ? 'signup-msg-ok' : 'signup-msg-error');
  }
  function bad(text, el) { say(text, false); if (el) el.focus(); return false; }

  toggle.addEventListener('click', function () {
    var open = form.hidden;
    form.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    toggle.textContent = open ? '닫기' : '변경하기 →';
    if (open) cur.focus();
  });

  // ★서버 코드를 그대로 화면에 내보내지 않는다 — 아는 건 번역하고 모르는 건 사람 말로 폴백한다.
  //   (signup.html·login-page.js 와 «같은 규칙»)
  var REASON = {
    wrong_current_password: '현재 비밀번호가 맞지 않아요.',
    weak_password:          '새 비밀번호는 8자 이상이어야 해요.',
    same_password:          '지금 쓰는 비밀번호와 같아요. 다른 걸로 정해 주세요.',
    current_required:       '현재 비밀번호를 입력해 주세요.',
    invalid_session:        '로그인이 풀렸어요. 다시 로그인한 뒤 시도해 주세요.',
    too_many_attempts:      '시도가 너무 많아요. 잠시 후 다시 시도해 주세요.',
    invalid_body:           '요청을 읽지 못했어요. 새로고침한 뒤 다시 시도해 주세요.',
    internal_error:         '서버 오류예요. 잠시 후 다시 시도해 주세요.'
  };

  // ★성공하면 «다시 열지 않는다». 2.2초 뒤 로그인 화면으로 나가는 동안 한 번 더 눌리면
  //   빈 폼 검증이 «성공 문구»를 덮어써서, 성공한 사람에게 「현재 비밀번호를 입력해 주세요」가 뜬다.
  //   성공을 실패로 오인시키는 화면은 실패보다 나쁘다.
  var okDone = false;

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (okDone) return;
    var token = '';
    try { token = sessionStorage.getItem('sms_token') || ''; } catch (e2) {}
    if (!token) return bad('로그인이 풀렸어요. 다시 로그인해 주세요.');
    if (!cur.value)                 return bad('현재 비밀번호를 입력해 주세요.', cur);
    if ((nw.value || '').length < 8) return bad('새 비밀번호는 8자 이상이어야 해요.', nw);
    if (nw.value !== nw2.value)      return bad('새 비밀번호가 서로 달라요.', nw2);
    if (nw.value === cur.value)      return bad('지금 쓰는 비밀번호와 같아요. 다른 걸로 정해 주세요.', nw);

    submit.disabled = true;
    var original = submit.textContent;
    submit.textContent = '바꾸는 중…';
    say('', true);

    fetch('/api/license/change-password', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionToken: token, currentPassword: cur.value, newPassword: nw.value })
    })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { r: r, d: d }; }); })
      .then(function (o) {
        if (!o.r.ok || !o.d.ok) {
          say(REASON[o.d.reason] || '비밀번호를 바꾸지 못했어요. 잠시 후 다시 시도해 주세요.', false);
          return;
        }
        // ★서버가 «모든 세션»을 끊었다. 화면도 그 사실과 맞아야 한다 —
        //   여기서 저장소를 안 비우면 「로그인된 것처럼 보이는데 아무것도 안 되는」 상태가 된다.
        try {
          Object.keys(sessionStorage).filter(function (k) { return k.indexOf('sms_') === 0; })
                .forEach(function (k) { sessionStorage.removeItem(k); });
          sessionStorage.removeItem('goditor_after_login');
        } catch (e3) {}
        cur.value = nw.value = nw2.value = '';
        okDone = true;
        submit.textContent = '변경 완료';
        toggle.disabled = true;                 // 접기 토글도 잠근다 — 나가는 중이다
        say('비밀번호를 바꿨어요. 보안을 위해 모든 기기에서 로그아웃했어요 — 다시 로그인해 주세요.', true);
        setTimeout(function () { location.href = 'login.html?next=mypage'; }, 2200);
      })
      .catch(function () { say('네트워크 오류로 바꾸지 못했어요. 잠시 후 다시 시도해 주세요.', false); })
      .then(function () {
        if (okDone) return;                     // ★성공이면 잠근 채로 둔다
        submit.disabled = false; submit.textContent = original;
      });
  });
})();

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
