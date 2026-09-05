/* 히어로 제목 그라디언트 — 색도 궤적도 «매번 다르게» (현빈 2026-09-05, PR안)
 *
 * ★왜 JS 인가
 *   CSS @keyframes 는 «고정된 길»이다. 열 때마다 다른 궤적을 그리려면 길 자체를 새로 만들어야
 *   해서 Web Animations API 를 쓴다. 색·각도도 로드 시 난수로 뽑는다.
 *
 * ★★안전장치 — 이 파일이 죽어도 제목은 «보여야» 한다
 *   style.css 의 .title-line 은 «완성된 정적 그라디언트»를 이미 갖고 있다.
 *   여기서는 그 위에 색과 움직임만 덮는다. 스크립트가 실패하면 정적 그라디언트로 남는다.
 *   ⛔절대 CSS 쪽에서 -webkit-text-fill-color:transparent 만 두고 배경을 JS 로 넣지 마라 —
 *     JS 가 죽는 순간 글자가 «투명»해져 제목이 사라진다.
 *
 * ⚠️테마마다 팔레트가 다르다. 다크는 밝은 색, 라이트는 어두운 색이어야 읽힌다.
 *   같은 팔레트를 쓰면 한쪽에서 글자가 배경에 묻는다.
 */
(function () {
  var root = document.documentElement;
  var lines = document.querySelectorAll('.hero-title .title-line');
  if (!lines.length) return;

  // 다크 = 밝은 무채·은빛 / 라이트 = 어두운 무채·먹빛. 채도는 양쪽 다 낮게 둔다.
  /* ⚠️파랑(#A9C9E8)은 «팔레트에 넣지 않는다» — 시안 PR 에도 없었다.
     넣으면 N5 계열의 무채 결에서 벗어나 다른 브랜드처럼 보인다. */
  var DARK  = ['#FFFFFF','#DCE3EA','#AEB8C4','#C8CEDA','#9AA6B4','#E6EAF0','#8E9BAC','#BFC9D6','#F4F6F9'];
  var LIGHT = ['#0B0B0E','#2C333F','#4A5462','#1B212B','#3B4553','#5A6474','#242B36','#414B5A','#1F2630'];
  /* 가운데 56% 자리 — 여기만 «난수가 아니다». 고정된 심지가 흐름의 방향을 잡아 준다. */
  var MID = { dark: '#FFFFFF', light: '#0B0B0E' };

  function isLight() {
    var t = root.getAttribute('data-theme');
    if (t === 'light') return true;
    if (t === 'dark') return false;
    return window.matchMedia('(prefers-color-scheme: light)').matches;   // 미지정 = OS 설정
  }
  function shuffle(a) { a = a.slice(); for (var i = a.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1)); var t = a[i]; a[i] = a[j]; a[j] = t; } return a; }

  /* 궤적 — 시작점으로 돌아와야 반복이 «끊기지» 않는다 */
  function randPath() {
    var kf = [{ backgroundPosition: '0% 50%' }];
    var n = 4 + Math.floor(Math.random() * 3);
    for (var i = 0; i < n; i++)
      kf.push({ backgroundPosition: Math.round(Math.random() * 100) + '% ' + Math.round(Math.random() * 100) + '%' });
    kf.push({ backgroundPosition: '0% 50%' });
    return kf;
  }

  var running = [];
  function apply() {
    running.forEach(function (a) { try { a.cancel(); } catch (e) {} });
    running = [];

    var pal = shuffle(isLight() ? LIGHT : DARK);
    var ang = (85 + Math.floor(Math.random() * 50)) + 'deg';

    lines.forEach(function (el, i) {
      el.style.setProperty('--hg-ang', ang);
      el.style.setProperty('--hg-mid', isLight() ? MID.light : MID.dark);
      for (var k = 1; k <= 5; k++) el.style.setProperty('--hg-c' + k, pal[k - 1]);

      // reduced-motion 이면 색만 바꾸고 «움직이지 않는다»
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

      el.getAnimations().forEach(function (a) { a.cancel(); });
      running.push(el.animate(randPath(), {
        duration: 13000 + Math.random() * 9000,
        iterations: Infinity,
        easing: 'ease-in-out',
        delay: -i * 2600            // 줄마다 어긋나게 — 세 줄이 물결처럼 이어진다
      }));
    });
  }

  apply();

  /* 테마를 바꾸면 팔레트를 다시 뽑는다. 안 그러면 라이트에서 흰 글자가 남아 안 읽힌다. */
  new MutationObserver(function (muts) {
    for (var i = 0; i < muts.length; i++)
      if (muts[i].attributeName === 'data-theme') { apply(); return; }
  }).observe(root, { attributes: true });

  var mq = window.matchMedia('(prefers-color-scheme: light)');
  (mq.addEventListener ? mq.addEventListener.bind(mq, 'change') : mq.addListener.bind(mq))(apply);
})();
