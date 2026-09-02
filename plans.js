/**
 * 요금제(옵션) 렌더러 — 앱 페이지 공용.
 *
 * ★구조: 라라스토어(소문의섬) → 상품(앱) → 옵션(등급).
 *   옵션은 «상품에 딸린 것»이라 data/apps.json 의 각 앱 안에 둔다.
 *   앱이 늘어도(고비디오 등) apps.json 에 plans 만 적으면 페이지는 그대로 동작한다
 *   — 카드를 HTML 에 하드코딩하면 앱마다 다시 만들어야 한다.
 *
 * 쓰는 법: <div class="plan-grid" data-app="goditor"></div> 를 두면 채워진다.
 */
(function () {
  var grid = document.querySelector('.plan-grid[data-app]');
  if (!grid) return;
  var appId = grid.getAttribute('data-app');

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  // ★business.json 은 이제 이 화면에서 안 읽는다 — 「결제 연동 전」 안내문을 뺐기 때문이다(2026-09-02).
  //   결제 가능 여부 판단(bankIsDummy)은 order.html·mypage.js 가 «각자» 한다. 여기서 읽으면 쓰이지 않는 값이 된다.
  fetch('data/apps.json?v=20260903c').then(function (r) { return r.ok ? r.json() : null; })
    .then(function (apps) {
      if (!apps) throw new Error('apps.json');
      var app = apps.filter(function (a) { return a.id === appId; })[0];
      if (!app || !app.plans || !app.plans.length) {
        grid.innerHTML = '<p class="plan-empty">요금제 정보를 준비 중입니다.</p>';
        return;
      }

      grid.innerHTML = app.plans.map(function (p) {
        var feats = p.features.map(function (f) {
          return f.ok
            ? '<li><span class="feature-dot">·</span> ' + esc(f.t) + '</li>'
            : '<li class="plan-feat-off"><span class="feature-dot">×</span> ' + esc(f.t) + '</li>';
        }).join('');


        // ★카드에서 «제일 큰 글자»는 등급 이름이다. 금액은 그 아래다.
        //   전에는 네 장 모두 「무료」가 제일 컸다. 이벤트로 전부 무료인 건 맞지만,
        //   그러면 네 카드가 똑같아 보여서 «비교표가 비교를 못 한다».
        //   비교해야 할 건 등급 차이지 이벤트가 아니다.
        //
        //   그래서 카드는 «자기 예시 금액»을 그대로 보여준다 — 이게 등급을 가르는 값이다.
        //   「지금 전부 무료」는 상단 이벤트 띠와 요금제 절 머리글이 이미 말했으니
        //   카드마다 되풀이하지 않는다.
        var priceHtml = '<span class="plan-amount">' + esc(p.price) + '</span>'
              + '<span class="plan-per"> / ' + esc(p.per) + '</span>';

        return '<div class="plan-card' + (p.now ? ' plan-card-now' : '') + '">'
          + (p.ribbon
              // ★kind 는 «데이터»에서 온다 — 문구를 /할인/ 로 넘겨짚으면 「반값」처럼
              //   할인인데 안 잡히거나, 등급 이름에 그 글자가 들어가면 잘못 잡힌다.
              ? '<p class="plan-ribbon' + (p.ribbonKind === 'save' ? ' plan-ribbon-save' : '') + '">'
                + esc(p.ribbon) + '</p>'
              : '')
          + '<h3 class="plan-name">' + esc(p.name) + '</h3>'
          + '<p class="plan-price">' + priceHtml + '</p>'
          // 무료 등급만 «항상» 이라는 정보가 따로 있다. 유료 등급은 위에서 이미 말했으니 비운다
          // (빈 줄을 남겨 카드 넷의 세로 축은 맞춘다).
          // ★빈 <p> 를 그리지 않는다 — FREE 가 사라진 뒤로는 늘 비어 있어 «빈 줄»만 남았다.
          + (p.priceNote ? '<p class="plan-price-note">' + esc(p.priceNote) + '</p>' : '')
          + '<div class="plan-divider"></div>'
          + '<ul class="plan-features">' + feats + '</ul>'
          + (p.id === 'free'
              ? '<a href="signup.html?app=goditor" class="plan-cta">시작하기 →</a>'
              // ★유료 등급은 «주문서»로 보낸다. 전에는 넷 다 가입 페이지로 가서
              //   「돈을 내겠다」는 의사를 받을 곳이 아예 없었다.
              // ★버튼 문구는 «등급마다 달라야» 한다. 이름만 쓰면 프로 1개월과 프로 12개월이
              //   둘 다 「프로로 업그레이드 →」가 되어 «어느 걸 누른 건지» 알 수 없다.
              //   apps.json 에 cta 를 적어 두면 그걸 쓰고, 없으면 종전대로 이름을 쓴다.
              : '<a href="order.html?plan=' + encodeURIComponent(p.id) + '" class="plan-cta">'
                  + esc(p.cta || (p.name + '로 업그레이드')) + ' →</a>')
          + '</div>';
      }).join('');

      // ★요금제 아래 안내문(plansNote + 「결제 연동 전」)은 현빈 지시로 제거했다(2026-09-02).
      //   ⚠️ 「실제 입금 금지」 고지가 사라진 게 아니다 — order.html:236 과 mypage.js:59 가
      //   같은 근거(business.json 의 bankIsDummy)로 «주문 화면과 마이페이지»에서 독립으로 띄운다.
      //   ⇒ 여기서만 뺐고 소비자 고지는 결제 직전 자리에 그대로 남아 있다.

      // 이벤트 종료 후 결제용 신청 버튼도 같은 데이터에서 만든다(무료 등급 제외)
      var launch = document.getElementById('order-launch');
      if (launch) {
        launch.innerHTML = app.plans.filter(function (p) { return p.id !== 'free'; })
          .map(function (p) {
            return '<button type="button" class="plan-cta plan-cta-quiet" data-plan="'
              + esc(p.id) + '" data-plan-label="' + esc(p.name) + '">' + esc(p.name) + ' 신청</button>';
          }).join('');
        if (window.__bindOrderButtons) window.__bindOrderButtons();
      }
    })
    .catch(function () {
      grid.innerHTML = '<p class="plan-empty">요금제를 불러오지 못했습니다. 새로고침해 주세요.</p>';
    });
})();
