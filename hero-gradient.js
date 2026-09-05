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
  /* ★★2026-09-05 «너울»로 고쳤다(현빈: 「파도 너울 정도의 느낌」).
   *   ⛔중간 지점을 «전부 난수»로 뽑으면 경로가 이리저리 튄다 — 물결이 아니라 «떨림»이다.
   *     x 가 20 → 90 → 15 → 70 으로 오가면 방향이 매 구간 뒤집힌다.
   *   ★너울은 «한 방향으로 밀려갔다가 돌아온다». 그래서 x 는 0 에서 최고점까지 «단조롭게»
   *     올라갔다 다시 내려오게 만든다. 난수는 «얼마나 멀리 · 어떤 간격으로 · y 는 얼마나»
   *     에만 남긴다 — 매번 다르되 «구르는 결»은 흐트러지지 않는다.
   *   ★y 는 작게 흔든다(±18). 크게 흔들면 대각선 그라디언트가 위아래로 튀어 멀미가 난다. */
  function randPath() {
    var peak = 55 + Math.random() * 45;                 // 이번 너울이 밀려갈 «최고점»
    var n    = 3 + Math.floor(Math.random() * 2);       // 올라가는 구간 3~4개 (내려올 때도 같은 수)
    var kf   = [];
    function y() { return Math.round(50 + (Math.random() * 36 - 18)); }

    kf.push({ backgroundPosition: '0% 50%' });
    for (var i = 1; i <= n; i++) {                      // ↗ 밀려간다
      var t = i / n;
      kf.push({ backgroundPosition: Math.round(peak * t * (0.75 + Math.random() * 0.5)) + '% ' + y() + '%' });
    }
    for (var j = n - 1; j >= 1; j--) {                  // ↘ 돌아온다 (같은 길이 아니다 — y 가 다르다)
      var u = j / n;
      kf.push({ backgroundPosition: Math.round(peak * u * (0.75 + Math.random() * 0.5)) + '% ' + y() + '%' });
    }
    kf.push({ backgroundPosition: '0% 50%' });
    return kf;
  }

  /* ★2026-09-05 밤 속도 — 두 번 만졌다. 최종 «14~20.5초»(평균 17.3).
       14~22 (원안) → 11.5~17.5 (「좀 느린 것 같다」) → 14~20.5 (「조금 느리게」)
       → «12~17.5» (「너~무 느려서 아~주 쪼금만 속도 올리자」, 2026-09-05 라이브 보고)
     ⚠️같은 초라도 background-size 가 120% 면 «덜 움직여» 보인다(창이 램프의 17% 만
       미끄러진다). 지금 170% 로 되돌리면서 체감 속도가 «같이» 올라간다 —
       그래서 시간은 «조금만» 줄였다. 둘을 동시에 세게 올리면 과해진다.
     ⚠️여기서 더 올리면 «흐름»이 아니라 «깜빡임»이 된다 — 은은함이 목적이라 배수로 안 올린다.
     ★줄마다 어긋나는 delay(2600ms)는 주기와 «비율»로 묶여 있다. 주기를 바꾸면 여기도
       같은 비율로 바꿔라 — 안 그러면 세 줄이 물결이 아니라 «따로» 논다. */
  lines.forEach(function (el, i) {
    el.animate(randPath(), {
      duration: 12000 + Math.random() * 5500,
      iterations: Infinity,
      /* ★★easing 을 «linear» 로 바꿨다(현빈: 「파도 너울 정도의 느낌이면 좋겠다」).
       *   ⛔ease-in-out 은 «구간마다» 걸린다 — 중간 지점이 4~6개면 한 바퀴에 대여섯 번
       *     감속·정지·재가속을 한다. 그 «멈칫»이 「너무 느리다」의 진짜 원인이었다.
       *     시간을 줄여도 멈칫은 그대로라 빨라진 느낌이 안 난다.
       *   ★너울은 «멈추지 않는다». 속도가 일정해야 물결이지, 끊기면 «흔들림»이다.
       *     ⇒ 등속으로 흐르게 두고, «방향»만 중간 지점들이 천천히 바꾸게 한다. */
      easing: 'linear',
      delay: -i * 2600        // 줄마다 어긋나게 — 세 줄이 물결처럼 이어진다
    });
  });
})();
