/**
 * 약관·개인정보처리방침 렌더러 — terms.html / privacy.html 공용.
 *
 * ★본문은 data/legal.json 에서 온다. 값이 비어 있으면 «준비 중»을 «분명히» 말한다.
 *   빈 문서를 그럴듯하게 보이게 만들면 안 된다 — 동의 체크박스가 가리키는 문서라
 *   내용이 없는데 있는 척하면 가짜 사업자정보·가짜 계좌와 같은 종류의 사고가 된다.
 */
(function () {
  var root = document.getElementById('legal-body');
  if (!root) return;
  var docKey = root.getAttribute('data-doc');   // 'terms' | 'privacy'

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  fetch('data/legal.json?v=20260903c')
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) {
      if (!d) throw new Error('legal.json');
      var doc = d[docKey] || {};
      var secs = doc.sections || [];
      var titleEl = document.getElementById('legal-title');
      if (titleEl && doc.title) titleEl.textContent = doc.title;

      if (!secs.length) {
        root.innerHTML =
          '<div class="legal-empty">'
          + '<p class="legal-empty-title">이 문서는 아직 준비 중입니다.</p>'
          + '<p class="legal-empty-sub">'
          + '작성이 끝나기 전까지는 <b>회원가입을 받지 않습니다.</b> '
          + '문의는 <a href="mailto:coq3820@gmail.com">coq3820@gmail.com</a> 로 주세요.'
          + '</p></div>';
        return;
      }

      var meta = [];
      if (d.version) meta.push('버전 ' + esc(d.version));
      if (d.effectiveDate) meta.push('시행일 ' + esc(d.effectiveDate));
      root.innerHTML =
        (meta.length ? '<p class="legal-meta">' + meta.join(' · ') + '</p>' : '')
        + secs.map(function (s, i) {
            return '<section class="legal-sec" id="legal-' + (i + 1) + '">'
              + '<h2 class="legal-h">제' + (i + 1) + '조 ' + esc(s.heading || '') + '</h2>'
              + (s.body || []).map(function (p) { return '<p class="legal-p">' + esc(p) + '</p>'; }).join('')
              + '</section>';
          }).join('');

      // ★목차 — 개발자문서와 «같은» .doc-toc 구조를 쓴다(새 디자인 안 만든다).
      //   조문이 16~20개라 그냥 두면 6,000px 짜리 글 덩어리가 된다.
      var toc = document.querySelector('.doc-toc nav');
      if (toc) {
        toc.innerHTML = secs.map(function (sec, k) {
          return '<a href="#legal-' + (k + 1) + '">제' + (k + 1) + '조 ' + esc(sec.heading || '') + '</a>';
        }).join('');
        var links = [].slice.call(toc.querySelectorAll('a'));
        // «읽는 선»을 지난 마지막 절이 지금 보고 있는 것 — 바닥이면 마지막 절.
        // (관측 띠 방식은 맨 위·맨 아래에서 아무것도 안 켜진다 — goditor.html 에서 겪었다)
        function pick() {
          var doc = document.documentElement;
          if (window.innerHeight + window.scrollY >= doc.scrollHeight - 4) return links.length - 1;
          var h = document.querySelector('header');
          var line = (h ? h.getBoundingClientRect().height : 64) + window.innerHeight * 0.2;
          var cur = 0;
          links.forEach(function (a, k) {
            var el = document.getElementById('legal-' + (k + 1));
            if (el && el.getBoundingClientRect().top <= line) cur = k;
          });
          return cur;
        }
        var ticking = false;
        function onScroll() {
          if (ticking) return;
          ticking = true;
          requestAnimationFrame(function () {
            var k = pick();
            links.forEach(function (a, j) { a.classList.toggle('on', j === k); });
            ticking = false;
          });
        }
        window.addEventListener('scroll', onScroll, { passive: true });
        window.addEventListener('resize', onScroll);
        onScroll();
      }
   })
    .catch(function () {
      root.innerHTML = '<div class="legal-empty"><p class="legal-empty-title">문서를 불러오지 못했습니다.</p>'
        + '<p class="legal-empty-sub">잠시 후 새로고침해 주세요.</p></div>';
    });
})();
