/**
 * 상단바 로그인 상태 반영 — 전 페이지 공용.
 *
 * ★왜 필요한가(2026-09-03 현빈 지적)
 *   로그인해도 상단이 「로그인 · 회원가입」 그대로였다. ★심지어 «방금 로그인한 그 화면»조차
 *   그랬다. 사용자는 로그인이 «안 된 줄» 알고 다시 로그인하려 든다.
 *   실측: 로그인 성공 → sessionStorage 에 토큰은 있는데 상단바는 「로그인 / 회원가입」.
 *
 * ★서버에 묻지 않는다.
 *   상단바 한 줄 때문에 전 페이지가 세션 검증 API 를 한 번씩 더 때릴 이유가 없다.
 *   여기가 하는 일은 «이 탭이 이미 아는 것»을 화면에 옮기는 것뿐이다.
 *   토큰이 낡았으면 마이페이지가 걸러낸다 — 실제로 «검증하는 자리»는 거기 하나면 된다.
 *   ⇒ 그래서 이 파일은 «표시»만 바꾼다. 여기서 권한을 판정하지 마라.
 *
 * ★세션은 sessionStorage 에 있다 = «탭 단위»다. 탭을 닫으면 로그아웃된다.
 *   이건 이 사이트의 기존 설계이고, 이 파일이 바꾸는 게 아니다(고치려면 별건으로).
 */
(function () {
  function loggedIn() {
    try { return !!sessionStorage.getItem('sms_token'); } catch (e) { return false; }
  }

  function makeLogout(a) {
    a.textContent = '로그아웃';
    a.setAttribute('href', '#');
    // ★로그아웃은 «이동»이 아니라 «동작»이다 — 마크업으로도 그렇게 말한다.
    //   ⑴화면 낭독기가 「링크」가 아니라 「버튼」으로 읽는다(접근성)
    //   ⑵검사기가 href="#" 를 «죽은 링크»로 오인하지 않는다
    //     (addEventListener 로 붙인 핸들러는 a.onclick 에 «안 보인다» — 2026-09-03 에 550건 오탐)
    a.setAttribute('role', 'button');
    a.addEventListener('click', function (e) {
      e.preventDefault();
      // ★sms_ 로 시작하는 걸 «전부» 지운다. 하나씩 지우면 새 키가 늘 때마다 빠뜨린다 —
      //   실제로 sms_orders·sms_plan 이 남아 «다음 사람에게 앞사람 주문·등급»이 보였다(UL-007).
      //   ⇒ login-page.js 의 로그아웃과 «같은 규칙»이다. 한쪽만 고치지 마라.
      try {
        Object.keys(sessionStorage)
          .filter(function (k) { return k.indexOf('sms_') === 0; })
          .forEach(function (k) { sessionStorage.removeItem(k); });
      } catch (e2) {}
      location.href = '/';
    });
  }

  function apply() {
    var nav = document.querySelector('.nav-links');
    if (!nav) return;
    if (!loggedIn()) return;                      // 로그아웃 상태 = 마크업 그대로가 정답
    if (nav.dataset.authApplied === '1') return;  // 두 번 부르면 「로그아웃」이 「마이페이지」로 덮인다
    nav.dataset.authApplied = '1';

    var loginA  = nav.querySelector('a[href$="login.html"]');
    var signupA = nav.querySelector('a[href$="signup.html"]');

    if (signupA) {
      // 일반 페이지 — 「로그인 · 회원가입」 두 칸이 있다. 각각 제자리를 바꾼다.
      if (loginA) { loginA.textContent = '마이페이지'; loginA.setAttribute('href', 'mypage.html'); }
      makeLogout(signupA);
    } else if (loginA) {
      // 마이페이지 — 「요금제 · 로그인」. 이미 마이페이지에 있으니 남은 칸은 로그아웃이어야 한다.
      makeLogout(loginA);
    } else {
      // 주문서 — 「요금제 · 마이페이지」. 나갈 문이 아예 없다. 하나 붙인다.
      // ★공용 PC 에서 «로그아웃할 방법이 없는 화면»은 만들면 안 된다.
      var a = document.createElement('a');
      nav.appendChild(a);
      makeLogout(a);
    }
  }

  // ★login.html 은 «로그인 뒤에» 다시 불러야 한다 — 이 스크립트가 돌 때는 아직 로그인 전이다.
  window.__navAuth = apply;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', apply);
  else apply();
})();
