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
// ★상단바는 nav-auth.js 가 맡는다(2026-09-03).
//   전에는 여기서 「로그인」을 «무조건» 「마이페이지」로 바꿨는데, 그러면 마이페이지 안에
//   «자기 자신을 가리키는 링크»가 남고, 정작 «로그아웃할 문»이 없었다.
//   ⇒ nav-auth.js 가 로그인 상태를 보고 이 칸을 「로그아웃」으로 만든다.

// ★표시명과 코드값을 가른다 — 서버는 코드값을 주고 화면은 표시명을 쓴다.
//   beta 는 등급이 아니라 «기간»이다. event_free 는 옛 서버 값으로 뜻이 같다.
// ★옛 id(starter·promax)도 남긴다 — 이미 그 값을 들고 있는 계정의 등급이 «빈칸»이 되지 않게.
var PLAN_LABEL = { beta:'BETA', event_free:'BETA', free:'FREE',
  intern:'INTERNSHIP', pro:'PRO', pro12:'PROx12', pro_training:'프로 트레이닝',
  starter:'STARTER', promax:'PRO MAX' };
var code = String(plan || '').toLowerCase();
document.getElementById('mp-email').textContent = email;

// ── 앱별 이용 현황 · 이름·연락처 ─────────────────────────────────
// ★서버에서 «한 번에» 받아온다(api/license/me). sessionStorage 에 없는 값(이름·연락처·사용 기록)이라
//   화면이 스스로 지어낼 수 없다. 못 받으면 «비워 두지» 말고 그 사실을 말한다.
(function loadMe() {
  var box = document.getElementById('mp-apps');
  var token = null;
  try { token = sessionStorage.getItem('sms_token') || ''; } catch (e) {}
  if (!token) { box.innerHTML = '<p class="mp-apps-note">이용 현황을 불러오려면 다시 로그인해 주세요.</p>'; return; }

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
        box.innerHTML = '<p class="mp-apps-note">이용 현황을 불러오지 못했어요. 새로고침해 주세요.</p>';
        return;
      }
      // 이름·연락처 — 확장 가입 «전»에 만들어진 계정은 값이 없다. 빈칸이 아니라 «없다»고 말한다.
      var nm = document.getElementById('mp-name');
      var ph = document.getElementById('mp-phone');
      if (nm) nm.textContent = (d.profile && d.profile.name) || '등록 안 됨';
      if (ph) ph.textContent = (d.profile && d.profile.phone)
        ? String(d.profile.phone).replace(/^(\d{3})(\d{3,4})(\d{4})$/, '$1-$2-$3')
        : '등록 안 됨';

      box.innerHTML = (d.apps || []).map(function (a) {
        // ★«기록을 안 남기는 앱»과 «아직 안 쓴 앱»을 다르게 말한다 — 둘은 다른 사실이다.
        var used = !a.tracksUsage
          ? '<span class="mp-app-dim">사용 기록을 남기지 않아요</span>'
          : (a.lastUsedAt
              ? '마지막 사용 <b>' + esc(fmt(a.lastUsedAt)) + '</b>'
                + (a.uses ? ' · ' + a.uses + '회' : '')
              : '<span class="mp-app-dim">아직 사용 기록이 없어요</span>');
        // ★번들이 있으면 «언제부터 쓰는지»가 있다. 그게 「이용 중」이라는 말의 근거다.
        var since = a.firstSeenAt ? '<span class="mp-app-dim"> · ' + esc(fmt(a.firstSeenAt)) + '부터</span>' : '';
        // 결제방식은 «있을 때만» 적는다. 없는데 「무료」라고 쓰면 유료 전환 뒤 거짓이 된다.
        var pay = a.payment ? '<p class="mp-app-note">결제 ' + esc(a.payment) + '</p>' : '';
        // ★최고 등급이면 「등급 올리기」를 안 그린다 — 눌러도 올릴 게 없는 링크는 거짓말이다.
        var up = a.canUpgrade ? '<a href="pricing.html" class="mp-app-up">등급 올리기 →</a>' : '';
        // ★운영 등급(88·99)은 «구매로 도달할 수 없는» 자리라 화면에서도 티가 나야 한다.
        var badge = a.staff ? ' mp-app-plan-staff' : '';
        return '<div class="mp-app">'
          + '<div class="mp-app-top">'
          +   '<span class="mp-app-name">' + esc(a.name) + '</span>'
          +   '<span class="mp-app-kind">' + (a.kind === 'service' ? '서비스' : '앱') + '</span>'
          + '</div>'
          + '<span class="mp-app-plan' + badge + '">' + esc(a.label) + '</span>'
          + pay
          + '<p class="mp-app-used">' + used + since + '</p>'
          + up
          + '</div>';
      }).join('') || '<p class="mp-apps-note">아직 이용 중인 서비스가 없어요. '
          + '앱이나 확장 프로그램에서 이 계정으로 로그인하면 여기에 나타납니다.</p>';
    })
    .catch(function () {
      box.innerHTML = '<p class="mp-apps-note">이용 현황을 불러오지 못했어요. 새로고침해 주세요.</p>';
    });
})();

// ── 계정 등급 ────────────────────────────────────────────────────────
// ★★등급 «이름»을 이제 실제로 그린다. 전에는 PLAN_LABEL 을 만들어 놓고 «쓰는 곳이 없어서»
//   화면엔 기한 꼬리말만 떴다 — 「뭐에 대한 베타테스트냐」의 절반이 이것이었다(현빈 2026-09-03).
var tierEl = document.getElementById('mp-tier');
if (tierEl) tierEl.textContent = PLAN_LABEL[code] || (plan ? String(plan).toUpperCase() : '—');

var untilTxt = '';
if (until) {
  var d = new Date(until);
  if (!isNaN(d)) {
    var left = Math.ceil((d - Date.now()) / 86400000);
    // ★toISOString() 은 UTC 다 — 2026-12-31T23:59:59Z 를 그렇게 찍으면 한국 사용자에게
    //   「2026-12-31 까지」로 «하루 이르게» 보인다(실제 만료는 KST 2027-01-01).
    untilTxt = kstDate(d) + ' 까지 이용할 수 있어요'
             + (left >= 0 && left <= 30 ? ' · ' + left + '일 남음' : '');
  }
}
document.getElementById('mp-until').textContent = untilTxt;

// ★★평소엔 «아무 말도 안 한다»(현빈 2026-09-03: 「이런말은 왜 필요해?? 회원가입만
//   했을때는 이런내용이 필요없는데?」).
//   ⇒ 맞다. 「무슨 베타냐」의 원인은 «등급 이름이 안 그려진 것»이었지 설명이 부족한 게
//     아니었다. 이름 + 「이 계정 전체에 적용」 배지로 이미 답이 됐는데 해설을 세 문장
//     더 붙인 건 군더더기였다. 화면은 설명서가 아니다.
//   ★남기는 건 «지금 행동이 필요한 때» 한 줄뿐이다 — 기한이 임박했을 때.
//     그때는 「곧 바뀐다」가 정보가 되고, 그 전엔 소음이다.
var noteEl = document.getElementById('mp-tier-note');
if (noteEl) {
  var days = null;
  if (until) { var du = new Date(until); if (!isNaN(du)) days = Math.ceil((du - Date.now()) / 86400000); }
  if ((code === 'beta' || code === 'event_free') && days !== null && days >= 0 && days <= 30) {
    noteEl.textContent = '기간이 끝나면 FREE 등급으로 바뀌어요. 요금제에서 등급을 올리실 수 있습니다.';
  } else {
    noteEl.textContent = '';   // ★CSS 의 :empty 가 이 칸을 통째로 감춘다
  }
}

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
fetch('data/business.json?v=20260904b').then(function (r) { return r.ok ? r.json() : null; })
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
