/**
 * GODITOR 소개 페이지 — 화면 거동(진입 표시·내비).
 *
 * 2026-09-02: HTML 안에 있던 것을 파일로 뺐다.
 *   HTML 은 no-cache 라 인라인이면 페이지를 볼 때마다 다시 내려받는다.
 * ★다운로드 로직은 responsibility 가 달라 goditor-download.js 로 따로 뺐다.
 * ★<body> 끝에서 불린다 — 문서가 이미 그려진 뒤다.
 */
(function () {
var d = document.documentElement;
d.classList.add('js');
requestAnimationFrame(function () {
  requestAnimationFrame(function () { document.body.classList.add('hero-in'); });
});
    })();

(function () {
var el = document.querySelector('.detail-icon');
if (!el) return;
// 터치 기기엔 «호버»가 없다. 붙여봐야 첫 탭이 틸트로 먹힌다.
if (!window.matchMedia('(hover: hover)').matches) return;
if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

function enable() {
  el.addEventListener('mousemove', function (e) {
    // 좌표는 «추측하지 않고» rect 로 잰다 — 아이콘 크기가 바뀌어도 따라온다
    var r = el.getBoundingClientRect();
    var px = (e.clientX - r.left) / r.width  - 0.5;
    var py = (e.clientY - r.top)  / r.height - 0.5;
    el.classList.add('is-tilt');
    el.style.transform = 'perspective(420px) rotateY(' + (px * 16).toFixed(2) + 'deg)'
                       + ' rotateX(' + (-py * 16).toFixed(2) + 'deg) scale(1.06)';
  });
  el.addEventListener('mouseleave', function () {
    el.classList.remove('is-tilt');
    el.style.transform = '';
  });
}

// ★진입 애니메이션과 틸트가 «같은 transform 을 두고 다툰다».
//   진입 중에 마우스를 올리면 인라인 transform 이 애니메이션을 중간에 덮어 튄다.
//   그래서 진입이 «끝난 뒤에» 틸트를 붙인다.
//   ::after 광택도 animationend 를 올려보내므로 이름으로 걸러낸다.
var armed = false;
el.addEventListener('animationend', function (e) {
  if (armed || e.animationName !== 'heroRise') return;
  armed = true;
  enable();
});
    })();

// 앱 내비 — 지금 보고 있는 구간을 표시한다.
    // 링크만 있고 «어디에 있는지»가 없으면 내비가 아니라 그냥 링크 묶음이다.
    //
/* scroll-spy -> appnav-spy.js */
