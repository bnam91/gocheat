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

  fetch('data/apps.json')
    .then(function (r) { return r.ok ? r.json() : null; })
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
          + (p.ribbon ? '<p class="plan-ribbon">' + esc(p.ribbon) + '</p>' : '')
          + '<h3 class="plan-name">' + esc(p.name) + '</h3>'
          + '<p class="plan-price">' + priceHtml + '</p>'
          // 무료 등급만 «항상» 이라는 정보가 따로 있다. 유료 등급은 위에서 이미 말했으니 비운다
          // (빈 줄을 남겨 카드 넷의 세로 축은 맞춘다).
          + '<p class="plan-price-note">' + (p.id === 'free' ? '언제나 무료' : '') + '</p>'
          + '<div class="plan-divider"></div>'
          + '<ul class="plan-features">' + feats + '</ul>'
          + '<a href="signup.html?app=goditor" class="plan-cta">시작하기 →</a>'
          + '</div>';
      }).join('');

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
