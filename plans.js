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
  fetch('data/apps.json?v=20260905m').then(function (r) { return r.ok ? r.json() : null; })
    .then(function (apps) {
      if (!apps) throw new Error('apps.json');
      var app = apps.filter(function (a) { return a.id === appId; })[0];
      if (!app || !app.plans || !app.plans.length) {
        grid.innerHTML = '<p class="plan-empty">요금제 정보를 준비 중입니다.</p>';
        return;
      }

      // ★hidden:true 인 등급은 «그리지 않는다»(현빈 2026-09-02: 프로 트레이닝 숨김).
      //   데이터에서 지우지 않는 이유: 주문 화이트리스트·기존 계정의 등급 표시가 그 값을 쓴다.
      //   ⇒ 「파는 것」만 멈추고 「있는 것」은 살려 둔다. 되살릴 땐 apps.json 의 hidden 한 줄만 지우면 된다.
      var shown = app.plans.filter(function (p) { return p.hidden !== true; });
      if (!shown.length) { grid.innerHTML = '<p class="plan-empty">요금제 정보를 준비 중입니다.</p>'; return; }
      // ★제목의 «등급 수»를 여기서 채운다 — 손으로 적으면 등급이 바뀔 때마다 늙는다(실제로 두 번 늙었다).
      var t = document.getElementById('plan-count-title');
      if (t) {
        var KO = ['', '한', '두', '세', '네', '다섯', '여섯', '일곱', '여덟', '아홉'];
        var word = KO[shown.length] || String(shown.length);
        t.textContent = word + ' 가지 등급의 구독제입니다.';
      }

      grid.innerHTML = shown.map(function (p) {
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
        // ★★정가 «낙차»를 보여 준다(현빈 2026-09-05: 「베타테스트 무료 개이득 이런 느낌이 부족하다」).
        //   ₩0 은 그냥 공짜지만 «₩80,000 에서 내려온 ₩0» 은 사건이다. 이벤트를 만드는 건
        //   색도 이모지도 아니고 «낙차»다.
        //   ★지어낸 정가가 아니다 — 바로 옆 칸(SOLO)에서 «실제로 그 값에 판다».
        //     옆에 원본이 서 있으니 거짓말을 할 수가 없는 구조다.
        //   ⚠️wasPrice 를 쓸 땐 그 값이 «다른 카드에 실재하는지» 확인해라. 없는 정가를
        //     그어 보이는 건 그냥 허위 할인 표시다.
        //   ⚠️금액과 기간은 «한 덩이»로 묶는다(.plan-now). .plan-price 가 flex column 이라
        //     안에 든 인라인 요소가 «각각 flex 항목»이 되어 세로로 쪼개진다 —
        //     묶지 않으면 「₩0」과 「/ 1개월」이 위아래로 갈라진다(2026-09-05 실제로 그랬다).
        var priceHtml = (p.wasPrice ? '<span class="plan-was">' + esc(p.wasPrice) + '</span>' : '')
              + '<span class="plan-priceline">'
              +   '<span class="plan-amount">' + esc(p.price) + '</span>'
              +   '<span class="plan-per"> / ' + esc(p.per) + '</span>'
              + '</span>';

        // ★어느 카드를 «채워서» 강조할지는 데이터가 정한다(apps.json 의 emphasis).
        //   카드 순서나 등급 이름으로 넘겨짚지 않는다 — 순서는 바뀌고 이름도 바뀐다.
        return '<div class="plan-card' + (p.now ? ' plan-card-now' : '')
          + (p.emphasis === 'accent' ? ' plan-card-accent' : '')
          // ★muted = 「지금은 이걸 팔지 않는다」를 «보여만» 준다. 링크는 살아 있다 —
          //   진짜로 못 누르게 하려면 comingSoon 처럼 href 를 빼야 하고, 그건 별개 결정이다.
          + (p.muted ? ' plan-card-muted' : '')
          // ★featured = 「지금 이걸 보라」. 테두리 하나로만 말한다 — 채우면 「추천」과 목소리가 겹친다.
          //   (.plan-card-featured 는 이미 style.css 에 있던 규칙이다. 새로 만들지 않았다.)
          + (p.featured ? ' plan-card-featured' : '') + '">'
          + (p.ribbon
              // ★kind 는 «데이터»에서 온다 — 문구를 /할인/ 로 넘겨짚으면 「반값」처럼
              //   할인인데 안 잡히거나, 등급 이름에 그 글자가 들어가면 잘못 잡힌다.
              ? '<p class="plan-ribbon'
                + (p.ribbonKind === 'save' ? ' plan-ribbon-save' : '')
                + (p.ribbonKind === 'quiet' ? ' plan-ribbon-quiet' : '') + '">'
                + esc(p.ribbon) + '</p>'
              : '')
          + '<h3 class="plan-name">' + esc(p.name) + '</h3>'
          + '<p class="plan-price">' + priceHtml + '</p>'
          // 무료 등급만 «항상» 이라는 정보가 따로 있다. 유료 등급은 위에서 이미 말했으니 비운다
          // (빈 줄을 남겨 카드 넷의 세로 축은 맞춘다).
          // ★빈 <p> 를 그리지 않는다 — FREE 가 사라진 뒤로는 늘 비어 있어 «빈 줄»만 남았다.
          // ★주석은 «절 단위»로 줄이 나뉘게 한다(현빈 2026-09-02: 「줄바꿈이 이상하다」).
          //   전에는 한 덩이라 「월 ₩153,000 상당 · 정가 / ₩2,160,000」처럼 «금액 앞»에서 끊겼다.
          //   ⇒ ' · ' 로 나눠 각 절을 nowrap 으로 묶는다. 줄이 나뉘어도 금액이 안 쪼개진다.
          //   ★구분점은 절 «안»에 두지 않는다 — 줄 끝에 점만 매달리는 꼴이 된다(푸터에서 겪은 것과 같다).
          + (p.priceNote
              ? '<p class="plan-price-note">'
                + String(p.priceNote).split(' · ').map(function (seg, i) {
                    return (i ? '<span class="note-sep"> · </span>' : '')
                      + '<span class="note-seg">' + esc(seg) + '</span>';
                  }).join('')
                + '</p>'
              : '')
          + '<div class="plan-divider"></div>'
          + '<ul class="plan-features">' + feats + '</ul>'
          // ★★「하루 얼마」는 «금액에서 계산»한다 — 손으로 적으면 가격을 바꿀 때 반드시 늙는다.
          //   (오늘만 두 번 겪었다: 등급 수 문장, 등급 이름) 여기서는 price·per 가 유일한 진실이다.
          //   ⚠️일수 = 개월 × 365/12 (12개월 = 365일). 개월을 30일로 곱하면 1년이 360일이 되어
          //     하루 단가가 «실제보다 비싸게» 나온다 — 우리가 손해 보는 쪽이라 더 조심해야 한다.
          //   ★할인 문구는 리본 값을 그대로 쓴다(「15% 할인」). 두 곳에 따로 적으면 한쪽이 어긋난다.
          //   ★못 세면 «아무것도 안 그린다» — 틀린 숫자를 보여주느니 안 보여주는 게 낫다.
          + (function () {
              if (!p.dailyNote) return '';
              var won = parseInt(String(p.price).replace(/[^0-9]/g, ''), 10);
              var mon = parseInt(String(p.per || '').replace(/[^0-9]/g, ''), 10);
              if (!won || !mon) return '';
              var days = Math.round(mon * 365 / 12);
              var per  = Math.round(won / days / 10) * 10;
              // 형식: [12개월] 15% 할인 · 하루 약 5,030원   (현빈 2026-09-02)
              //   ★기간·할인·하루단가를 «전부 데이터에서» 만든다. 셋 중 하나만 손으로 적어도
              //     가격을 바꿀 때 그것만 남아 어긋난다.
              //   ★「약」을 붙인다 — 365 로 나눈 값이라 실제 결제와 1원 단위로는 안 맞는다.
              //     반올림한 값을 «단정»하면 그게 곧 틀린 표기가 된다.
              var term = p.per ? '<span class="plan-daily-term">[' + esc(p.per) + ']</span> ' : '';
              var save = (p.ribbonKind === 'save' && p.ribbon) ? esc(p.ribbon) + ' ' : '';
              return '<p class="plan-daily">' + term + save
                   + '<span class="note-sep">· </span>하루 약 '
                   + per.toLocaleString('ko-KR') + '원</p>';
            })()
          + (p.id === 'free'
              ? '<a href="signup.html?app=goditor" class="plan-cta">시작하기 →</a>'
              // ★★값이 0원인 등급은 «주문서로 보내지 않는다»(현빈 2026-09-05: 「결제할 필요는
              //   없으니 바로 다운로드 버튼처럼 드라이브를 열어주면 되겠다」).
              //   무통장입금 주문서는 「입금할 금액」을 말하는 화면이다. 0원짜리를 거기로 보내면
              //   낼 것이 없는 사람에게 계좌를 보여 준다 — 화면이 거짓말을 하게 된다.
              //   ⇒ apps.json 의 ctaAction:"download" 로 «지금은 받기만 하면 된다»를 말한다.
              //
              //   ⚠️주소를 여기에 «박지 않는다». 다운로드 주소의 단 한 벌은 data/downloads.json
              //     이고 서버(api/license/download.js)도 그 파일을 본다. 여기 박으면 두 벌이 되어
              //     드라이브를 옮길 때 한쪽만 고치는 사고가 난다(그 파일 _why 가 경고하는 것).
              //   ⇒ 기본값은 «사이트 안»의 다운로드 절로 두고, 아래에서 downloads.json 을 읽어
              //     플랫폼별 드라이브 주소로 «올려친다». 못 읽어도 막다른 길이 아니다.
              : p.ctaAction === 'download'
              ? '<a href="goditor.html#download" class="plan-cta" data-cta-download="1">'
                  + esc(p.cta || (p.name + ' 다운로드')) + ' →</a>'
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
        launch.innerHTML = shown.filter(function (p) { return p.id !== 'free'; })
          .map(function (p) {
            return '<button type="button" class="plan-cta plan-cta-quiet" data-plan="'
              + esc(p.id) + '" data-plan-label="' + esc(p.name) + '">' + esc(p.name) + ' 신청</button>';
          }).join('');
        if (window.__bindOrderButtons) window.__bindOrderButtons();
      }

      /* ★다운로드 CTA 를 «플랫폼별 드라이브 주소»로 올려친다.
       *   goditor-download.js 와 «같은 파일»(data/downloads.json)을 본다 — 주소는 한 벌이다.
       *   ⚠️맥은 ARM64/Intel 을 브라우저로 구분할 방법이 없다. 그래서 여기서는 «상위 폴더»로
       *     보낸다 — 세 폴더가 다 보이므로 잘못 짚어 놓고 우기는 것보다 낫다.
       *     (한 번에 맞히는 건 goditor.html 의 다운로드 절이 한다. 거기엔 Intel 경로가 나란히 있다.)
       *   ★못 읽으면 아무것도 «안 바꾼다». 기본값이 사이트 안의 다운로드 절이라 막다른 길이 없다.
       *   ★새 탭으로 연다 — 요금표를 보다가 드라이브로 «갈아타면» 비교하던 맥락이 사라진다. */
      var dlBtns = grid.querySelectorAll('[data-cta-download]');
      if (dlBtns.length) {
        fetch('data/downloads.json?v=20260905m')
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (dl) {
            var u = dl && dl.goditor;
            if (!u) return;
            var ua = navigator.userAgent || '';
            var isWin = /Windows/i.test(ua);
            var isMac = /Mac OS X|Macintosh/i.test(ua) && !/iPhone|iPad/i.test(ua);
            // 맥은 칩이 갈리므로 «상위 폴더»(빈 키)로 보낸다. 윈도만 딱 짚는다.
            var href = isWin ? u['win'] : (isMac ? u[''] : u['']);
            if (!href) return;
            dlBtns.forEach(function (b) {
              b.href = href;
              b.target = '_blank';
              b.rel = 'noopener';
            });
          })
          .catch(function () { /* 주소를 못 올려쳐도 기본 링크가 살아 있다 */ });
      }
    })
    .catch(function () {
      grid.innerHTML = '<p class="plan-empty">요금제를 불러오지 못했습니다. 새로고침해 주세요.</p>';
    });
})();
