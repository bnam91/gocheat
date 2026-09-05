/* 히어로 제목 — «움직임만» 매번 다르게 (현빈 2026-09-05, X2+X3 조합)
 *
 * ★색은 이 파일이 «건드리지 않는다». style.css 가 N5 순서로 고정해 뒀다
 *   (흰 → 연은빛 → 살짝 파랑 → 심지 → 은빛 → 짙은 회색).
 *   앞 판(PR)은 색까지 난수로 뽑았는데, 색이 서로 상쇄되어 N5 의 결이 사라졌다.
 *   ⇒ 여기서는 «궤적과 속도»만 난수로 만든다. 결은 그대로, 움직임만 매번 다르다.
 *
 * ★왜 JS 인가 — CSS @keyframes 는 «고정된 길»이다. 열 때마다 다른 궤적을 그리려면
 *   길 자체를 새로 만들어야 해서 Web Animations API 를 쓴다.
 *
 * ★★이 파일이 죽어도 제목은 «보인다». style.css 가 완성된 정적 그라디언트를 갖고 있고
 *   여기서는 움직임만 얹기 때문이다. 색을 JS 로 넣지 «않는» 이유이기도 하다.
 *
 * ⚠️테마는 CSS 가 처리한다([data-theme] · prefers-color-scheme). 이 파일은 색을 안 만지므로
 *   테마를 감시할 필요가 없다 — PR 판에 있던 MutationObserver 가 여기서는 사라졌다.
 */
(function () {
  var lines = document.querySelectorAll('.hero-title .title-line');
  if (!lines.length || !document.body.animate) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;  // 색만 남고 멈춘다

  /* 궤적 — 시작점으로 돌아와야 반복이 «끊기지» 않는다 */
  function randPath() {
    var kf = [{ backgroundPosition: '0% 50%' }];
    var n = 4 + Math.floor(Math.random() * 3);          // 중간 지점 4~6개
    for (var i = 0; i < n; i++)
      kf.push({ backgroundPosition: Math.round(Math.random() * 100) + '% ' + Math.round(Math.random() * 100) + '%' });
    kf.push({ backgroundPosition: '0% 50%' });
    return kf;
  }

  lines.forEach(function (el, i) {
    el.animate(randPath(), {
      duration: 14000 + Math.random() * 8000,
      iterations: Infinity,
      easing: 'ease-in-out',
      delay: -i * 2600        // 줄마다 어긋나게 — 세 줄이 물결처럼 이어진다
    });
  });
})();
