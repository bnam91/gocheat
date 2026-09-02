/**
 * 개발자문서 목차 — goditor-api.html 전용.
 *
 * 2026-09-02: HTML 안에 있던 것을 파일로 뺐다. HTML 은 no-cache 라
 *   인라인이면 페이지를 볼 때마다 다시 내려받는다.
 * ★<body> 끝에서 불린다 — 문서가 이미 그려진 뒤라 DOMContentLoaded 를 기다릴 필요가 없다.
 */
/* 목차 현재위치 표시 — JS 없어도 링크는 동작한다(점진적 향상). */
  (function () {
var links = [].slice.call(document.querySelectorAll('.doc-toc a'));
if (!links.length || !('IntersectionObserver' in window)) return;
var map = {};
links.forEach(function (a) {
  var el = document.getElementById(a.getAttribute('href').slice(1));
  if (el) map[el.id] = a;
});
var io = new IntersectionObserver(function (entries) {
  entries.forEach(function (e) {
    if (!e.isIntersecting) return;
    links.forEach(function (a) { a.classList.remove('on'); });
    if (map[e.target.id]) map[e.target.id].classList.add('on');
  });
}, { rootMargin: '0px 0px -70% 0px', threshold: 0 });
Object.keys(map).forEach(function (id) { io.observe(document.getElementById(id)); });
// ★맨 위에서는 어느 구간도 «관측 띠»에 안 걸려 아무것도 강조되지 않았다.
//   첫 절을 기본으로 켜 둔다 — 스크롤하면 관측기가 곧 정정한다.
if (!links.some(function (a) { return a.classList.contains('on'); })) links[0].classList.add('on');
  })();
