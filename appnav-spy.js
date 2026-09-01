/**
 * 앱 소개 페이지 상단 내비의 «지금 보고 있는 구간» 표시 — goditor.html · godiv.html 공용.
 *
 * ★한 곳에 둔다: goditor 에만 있고 godiv 에 없어 고디브는 탭이 영영 안 켜졌다(2026-09-02).
 *   페이지에 묶인 값이 없다 — .appnav-link[data-spy] 와 같은 id 의 요소만 있으면 어디서든 돌다.
 */
    // ★IntersectionObserver 로 짰다가 실측에서 틀린 걸 확인하고 갈아엎었다.
    //   («관측 띠»에 아무 구간도 안 걸리면 직전 표시가 그대로 남는다. 특히
    //    #pricing 은 페이지 «끝»이라 화면 맨 위까지 올라올 수가 없어서 —
    //    스크롤이 바닥에서 멈춘다 — 영영 «개요»로 남았다.)
    //   그래서 «띠에 걸렸나»가 아니라 «읽는 선을 지났나»로 판정하고,
    //   바닥에 닿으면 마지막 구간을 고른다.
    (function () {
var links = [].slice.call(document.querySelectorAll('.appnav-link[data-spy]'));
if (!links.length) return;
var ids = links.map(function (a) { return a.getAttribute('data-spy'); });  // 문서 순서

function mark(id) {
  links.forEach(function (a) {
    a.classList.toggle('is-current', a.getAttribute('data-spy') === id);
  });
}

// «읽는 선» — 이 선을 지난 마지막 구간이 «지금 보고 있는 것»이다.
// ★고정값(120)이었는데 내비가 두 줄(100px)에서 한 줄(65px)로 줄면서 어긋났다.
//   높이를 손으로 적어두면 내비를 고칠 때마다 여기도 같이 고쳐야 한다 —
//   실제 헤더 높이를 «재서» 쓴다. 거기에 화면 높이의 1/5 를 여유로 둔다:
//   구간 머리가 화면 위쪽에 «들어오면» 그 구간을 읽기 시작한 것으로 본다.
//   (딱 헤더 밑선으로 잡으면 앵커 착지 오차 몇십 px 에 판정이 뒤집힌다)
function readLine() {
  var h = document.querySelector('header');
  return (h ? h.getBoundingClientRect().height : 64) + window.innerHeight * 0.2;
}
function pick() {
  var doc = document.documentElement;
  if (window.innerHeight + window.scrollY >= doc.scrollHeight - 4) {
    return ids[ids.length - 1];        // 바닥 = 마지막 구간
  }
  var cur = ids[0];
  var line = readLine();
  ids.forEach(function (id) {
    var el = document.getElementById(id);
    if (el && el.getBoundingClientRect().top <= line) cur = id;
  });
  return cur;
}

var ticking = false;
function onScroll() {
  if (ticking) return;
  ticking = true;
  requestAnimationFrame(function () { mark(pick()); ticking = false; });
}
window.addEventListener('scroll', onScroll, { passive: true });
window.addEventListener('resize', onScroll);
mark(pick());
    })();
