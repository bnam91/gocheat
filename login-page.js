/**
 * 로그인 화면 — 폼 제출·세션·로그인 후 상태 표시
 *
 * 2026-09-02: HTML 안에 있던 것을 파일로 뺐다.
 *   HTML 은 no-cache 라 인라인이면 페이지를 볼 때마다 다시 내려받는다.
 * ★<body> 끝에서 불린다 — 문서가 이미 그려진 뒤다.
 */
(function () {
  const form    = document.getElementById('login-form');
  const email   = document.getElementById('email');
  const pw      = document.getElementById('password');
  const submit  = document.getElementById('login-submit');
  const msg     = document.getElementById('login-msg');
  const panel   = document.getElementById('account-panel');
  const title   = document.getElementById('login-title');
  const sub     = document.getElementById('login-sub');
  const alt     = document.getElementById('login-alt');
  // ★UL-005: 'download-link' 는 «없는 id» 다(go-app 으로 이름이 바뀌며 JS 가 안 따라왔다).
  //   null 이라 showExpired() 첫 줄에서 TypeError → 바깥 catch 가 「서버에 연결할 수 없어요」로
  //   덮어써서, «만료 사용자에게 요금제 안내가 한 번도 안 나갔다». 결제 갱신 퍼널이 통째로 끊겼던 자리.
  const dlLink  = document.getElementById('download-link') || document.getElementById('go-app');
  const accNote = document.getElementById('acc-note');
  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    // ★표시명과 코드값을 가른다. 앱(projects.html)과 «같은 표»를 쓴다.
    //   beta 는 등급이 아니라 «기간»이다 — 서버가 BETA_UNTIL 을 보고 내려준다.
    //   event_free 는 옛 서버가 주던 값으로 뜻이 같아 함께 받아준다.
    const PLAN_LABEL = {
      beta: 'BETA',
      event_free: 'BETA',
      free: 'FREE',
      intern: '인턴',
      pro: '프로',
      pro12: '프로 12개월',
      pro_training: '프로 트레이닝',
      // ★옛 id 도 남긴다 — 이미 그 값을 들고 있는 계정이 있으면 지우는 순간
      //   화면의 등급이 «빈칸»으로 뜬다. 표기만 유지하는 비용은 0이다.
      starter: 'STARTER',
      promax: 'PRO MAX',
    };

  function fail(text, el) {
    msg.textContent = text;
    msg.className = 'signup-msg signup-msg-error';
    if (el) el.focus();
  }

  // ★한국 시간 고정. new Date().getFullYear() 계열을 쓰면 보는 사람의 시간대에 따라
  //   같은 계정이 다른 날짜로 보인다(해외에서 보면 하루 어긋남).
  function fmtDate(v) {
    if (!v) return '제한 없음';
    const d = new Date(v);
    if (isNaN(d.getTime())) return String(v);
    // ★표기 규칙은 사이트 전체가 「KST 기준 YYYY-MM-DD」 하나여야 한다.
    //   전에는 여기만 「2027년 1월 1일까지 (KST)」였고 마이페이지는 「2026-12-31 까지」라
    //   같은 값이 두 화면에서 «다른 날짜, 다른 모양»으로 보였다(2026-09-02 QA 발견).
    try {
      const s = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
      }).format(d);                                   // en-CA = YYYY-MM-DD
      return s + ' 까지';
    } catch (e) {
      return new Date(d.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10) + ' 까지';
    }
  }

  // 가입 직후 넘어온 이메일이 있으면 채워준다
  // ★키는 sms_email — signup.html:232 가 쓰는 키다. (구 goditor_email 은 쓰는 곳이 없어
  //   자동입력이 «한 번도» 동작한 적 없던 죽은 키였다.)
  try {
    const saved = sessionStorage.getItem('sms_email');
    if (saved) email.value = saved;
  } catch (e) { /* 스토리지 차단 환경 무시 */ }

  function showAccount(data) {
    document.getElementById('acc-email').textContent = data.email || email.value.trim();
    document.getElementById('acc-plan').textContent  = PLAN_LABEL[data.plan] || data.plan || '—';
    document.getElementById('acc-until').textContent = fmtDate(data.accessUntil);
    form.style.display = 'none';
    alt.style.display = 'none';
    title.textContent = '로그인되었습니다.';
    sub.textContent = '아래에서 이어서 진행하세요.';
    panel.classList.add('is-open');

    // ★"받으려다 로그인한" 사람은 다운로드로 돌려보낸다. 로그인 자체가 목적이 아니었다.
    try {
      // ★UL-010: next 가 order/mypage 면 «사려던 그 자리»로 돌려보낸다.
      //   전에는 next=download 만 처리해서, 주문하려고 로그인한 사람이 앱 목록으로 떨어졌다.
      var q = new URLSearchParams(location.search);
      var nx = q.get('next') || '';
      if (dlLink && nx === 'order' && q.get('plan')) {
        dlLink.textContent = '주문 이어서 하기 →';
        dlLink.href = 'order.html?plan=' + encodeURIComponent(q.get('plan'));
        dlLink.removeAttribute('target'); dlLink.classList.add('cta-pulse');
        title.textContent = '로그인되었습니다. 주문을 이어서 하세요.';
        sub.textContent = '아래 버튼을 누르면 주문서로 돌아갑니다.';
      } else if (dlLink && nx === 'mypage') {
        dlLink.textContent = '마이페이지로 →';
        dlLink.href = 'mypage.html';
        dlLink.removeAttribute('target'); dlLink.classList.add('cta-pulse');
        // ★NEW-07: 같은 곳으로 가는 버튼이 위아래로 둘 생겼다 — 고정 버튼을 숨긴다.
        var gm = document.getElementById('go-mypage'); if (gm) gm.style.display = 'none';
      }
      var wants = nx === 'download'
               || sessionStorage.getItem('goditor_after_login') === 'download';
      if (wants && dlLink) {
        // ★UL-006: 전엔 문구만 「다운로드가 열려요」로 바꾸고 «버튼은 앱 목록 그대로»였다.
        //   약속과 버튼이 어긋나 사용자는 없는 버튼을 찾았다. 버튼도 같이 바꾼다.
        // ★★R3-01: 여기가 «오픈 리다이렉트»였다. app=//example.org/x 를 주면
        //   '/' + '//example.org/x' = '///example.org/x' 가 되고 브라우저가 이를
        //   scheme-relative 로 읽어 «남의 호스트»로 나간다. 그것도 «다운로드 버튼»에서 —
        //   사용자는 진짜 사이트에서 진짜로 로그인한 «직후»에 남의 설치파일을 받는다.
        //   ⇒ 소독하지 않는다. «허용목록»으로 막는다(.gdt 엔트리명과 같은 원칙).
        var APP_OK = /^[a-z][a-z0-9-]{0,31}$/;
        var appq = 'goditor';
        try {
          var rawApp = new URLSearchParams(location.search).get('app') || '';
          if (APP_OK.test(rawApp)) appq = rawApp;
        } catch (e5) {}
        dlLink.textContent = 'GODITOR 받으러 가기 →';
        dlLink.href = '/' + appq + '.html#download';
        dlLink.removeAttribute('target');
        dlLink.classList.add('cta-pulse');
        title.textContent = '로그인되었습니다. 이어서 받으세요.';
        sub.textContent = '아래 버튼을 누르면 다운로드로 이동해요.';
      }
    } catch (e4) {}
    // ★비밀번호·세션토큰은 저장하지 않는다. 표시 연속성에 필요한 이메일만.
    // ★sessionToken 을 저장한다. 전엔 «검증하는 곳이 없어 보관 이득이 없다»고 안 넣었는데,
    //   이제 /session·/download 가 이 토큰으로 인증한다 — 저장 근거가 생겼다.
    //   sessionStorage 라 탭을 닫으면 사라진다. 비밀번호는 여전히 저장하지 않는다.
    try {
      sessionStorage.setItem('sms_email', data.email || email.value.trim());
      if (data.sessionToken) sessionStorage.setItem('sms_token', data.sessionToken);
      // ★마이페이지가 읽는다. 등급·기한은 서버가 «판정해서» 준 값이라 여기서 보관한다.
      // ★UL-008: 값이 없으면 «지운다». 안 지우면 앞 계정 등급이 그대로 남는다.
      if (data.plan) sessionStorage.setItem('sms_plan', data.plan); else sessionStorage.removeItem('sms_plan');
      if (data.accessUntil) sessionStorage.setItem('sms_until', data.accessUntil); else sessionStorage.removeItem('sms_until');
    } catch (e) {}
  }

  function showExpired(data) {
    document.getElementById('acc-email').textContent = data.email || email.value.trim();
    document.getElementById('acc-plan').textContent  = '기간 만료';
    document.getElementById('acc-until').textContent = fmtDate(data.accessUntil);
    dlLink.textContent = '요금제 보고 연장하기 →';
    dlLink.href = data.purchaseUrl || '/goditor.html#pricing';
    dlLink.removeAttribute('target');
    accNote.textContent = '이용 기간이 끝났어요. 요금제를 선택하면 계속 사용할 수 있습니다.';
    form.style.display = 'none';
    alt.style.display = 'none';
    title.textContent = '이용 기간이 끝났어요.';
    sub.textContent = '아래에서 요금제를 확인해 주세요.';
    panel.classList.add('is-open');
  }

  document.getElementById('logout-btn').addEventListener('click', function () {
    // ★UL-007: sms_ 로 시작하는 걸 «전부» 지운다. 하나씩 지우면 새 키가 늘 때마다 빠뜨린다 —
    //   실제로 sms_orders·sms_plan 이 남아서 «다음 사람에게 앞사람 주문·등급»이 보였다.
    try { Object.keys(sessionStorage).filter(function (k) { return k.indexOf('sms_') === 0; })
                .forEach(function (k) { sessionStorage.removeItem(k); });
          sessionStorage.removeItem('goditor_after_login'); } catch (e) {}
    window.location.reload();
  });

  // ★NEW-05: 「사겠다」고 온 사람 중 «계정 없는 쪽»은 가입 후 주문서로 못 돌아왔다.
  //   signup.html 은 next/app 을 받으면 되돌려주게 돼 있는데 «링크가 안 실어줬다».
  //   ⚠️ next 는 남이 준 값이다 — 허용목록으로 거른다(R3-01 과 같은 이유).
  (function () {
    try {
      var q0 = new URLSearchParams(location.search);
      var nx0 = q0.get('next') || '';
      if (!/^(order|mypage|download)$/.test(nx0)) return;
      var qs = 'next=' + encodeURIComponent(nx0);
      var pl0 = q0.get('plan') || '';
      if (/^[a-z][a-z0-9_-]{0,31}$/.test(pl0)) qs += '&plan=' + encodeURIComponent(pl0);
      var ap0 = q0.get('app') || '';
      if (/^[a-z][a-z0-9-]{0,31}$/.test(ap0)) qs += '&app=' + encodeURIComponent(ap0);
      Array.prototype.forEach.call(document.querySelectorAll('a[href^="signup.html"]'), function (a) {
        a.href = 'signup.html?' + qs;
      });
    } catch (e0) {}
  })();

  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    const emailVal = (email.value || '').trim();
    if (!emailVal)                return fail('이메일을 입력해주세요.', email);
    if (!emailRe.test(emailVal))  return fail('이메일 형식이 올바르지 않아요.', email);
    if (!pw.value)                return fail('비밀번호를 입력해주세요.', pw);

    submit.disabled = true;
    const original = submit.textContent;
    submit.textContent = '로그인 중…';
    msg.textContent = '';
    msg.className = 'signup-msg';

    try {
      const res = await fetch('/api/license/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: emailVal, password: pw.value }),
      });
      const data = await res.json().catch(function () { return {}; });

      // 만료는 HTTP 200 + ok:false 로 온다 — 에러가 아니라 별도 화면으로 안내한다
      if (res.status === 200 && data.ok === false && data.reason === 'expired') {
        pw.value = '';
        showExpired(data);
        return;
      }
      if (res.status === 401) return fail('이메일 또는 비밀번호가 올바르지 않아요.');
      if (res.status === 403) return fail('이메일 인증이 완료되지 않은 계정이에요.');
      if (!res.ok || !data.ok) {
        // ★모르는 코드까지 그대로 붙이면 「로그인에 실패했어요: internal_error」가 화면에 뜬다.
        //   아는 건 번역하고, 모르는 건 «코드를 숨기고» 사람 말로 폴백한다.
        const REASON = {
          invalid_credentials: '이메일 또는 비밀번호가 올바르지 않아요.',
          not_verified:        '이메일 인증이 완료되지 않은 계정이에요.',
          invalid_email:       '이메일 형식이 올바르지 않아요.',
          invalid_body:        '요청을 읽지 못했어요. 새로고침한 뒤 다시 시도해 주세요.',
          too_many_attempts:   '시도가 너무 많아요. 잠시 후 다시 시도해 주세요.',
          internal_error:      '서버 오류예요. 잠시 후 다시 시도해 주세요.',
        };
        return fail(REASON[data.reason] || '로그인에 실패했어요. 잠시 후 다시 시도해 주세요.');
      }

      pw.value = '';
      showAccount(data);
    } catch (err) {
      fail('로그인 서버에 연결할 수 없어요. 잠시 후 다시 시도해 주세요.');
    } finally {
      submit.disabled = false;
      submit.textContent = original;
    }
  });
})();
  

// ★계정은 «소문의섬» 계정이지 특정 앱 계정이 아니다. 기본 문구는 플랫폼 것으로 둔다.
//   다만 앱 페이지에서 넘어온 사람에게는 그 앱을 언급하는 편이 자연스러워서,
//   링크에 ?app=<id> 가 실려 오면 그 앱 이름으로 바꿔준다. 없으면 플랫폼 문구 그대로.
(function () {
  var app;
  try { app = new URLSearchParams(location.search).get('app'); } catch (e) { return; }
  if (!app) return;
  fetch('data/apps.json?v=20260903c').then(function (r) { return r.ok ? r.json() : null; })
    .then(function (apps) {
      if (!apps) return;
      var a = apps.filter(function (x) { return x.id === app; })[0];
      if (!a) return;
      window.__srcApp = a;
      var label = document.getElementById('lg-label');
      var mark  = document.getElementById('lg-mark');
      if (label) label.textContent = a.name + ' 로그인';
      if (mark && a.icon) { mark.src = a.icon; mark.alt = a.name; mark.hidden = false; }
      var go = document.getElementById('go-app');
      if (go && a.detailUrl) { go.textContent = a.name + ' 받으러 가기 →'; go.setAttribute('href', a.detailUrl); }
    }).catch(function () {});
})();
