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

  // ★결제가 «연동 전»인지는 business.json 한 곳에서만 판단한다(주문·마이페이지와 같은 근거).
  //   UL-001: 「금액은 예시」라고 써놓고 바로 아래 버튼이 실제 입금 안내로 이어지면 안 된다.
  Promise.all([
    fetch('data/apps.json').then(function (r) { return r.ok ? r.json() : null; }),
    fetch('data/business.json').then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; })
  ])
    .then(function (both) {
      var apps = both[0], biz = both[1];
      var payLive = !!(biz && biz.bankIsDummy === false);
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
          + (p.id === 'free'
              ? '<a href="signup.html?app=goditor" class="plan-cta">시작하기 →</a>'
              // ★유료 등급은 «주문서»로 보낸다. 전에는 넷 다 가입 페이지로 가서
              //   「돈을 내겠다」는 의사를 받을 곳이 아예 없었다.
              : '<a href="order.html?plan=' + encodeURIComponent(p.id) + '" class="plan-cta">'
                  + esc(p.name) + '로 업그레이드 →</a>')
          + '</div>';
      }).join('');

      // ★UL-017/NEW-03: apps.json 의 plansNote 를 아무도 안 읽어 화면에 안 나왔다.
      //   ⚠️ 그리고 이 블록이 «map 콜백 안»에 있어 등급 수(4)만큼 반복 출력됐다.
      //   카드 렌더가 «끝난 뒤» 한 번만 돈다. 카드마다 도는 게 아니다.
      //   화면은 「금액은 예시」라고만 말해서 「AI 이미지 월 200장」이 확정 스펙처럼 읽혔다.
      var note = [];
      if (app.plansNote) note.push(app.plansNote);
      if (!payLive) note.push('결제는 아직 연동 전입니다 — 주문 화면은 흐름 확인용이고 실제로 접수되지 않습니다.');
      if (note.length && grid.parentNode) {
        var noteEl = document.createElement('p');
        noteEl.className = 'plan-empty';
        noteEl.style.marginTop = '18px';
        noteEl.textContent = note.join(' ');
        grid.parentNode.insertBefore(noteEl, grid.nextSibling);
      }

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
