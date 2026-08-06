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

  fetch('data/legal.json')
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
            return '<section class="legal-sec">'
              + '<h2 class="legal-h">제' + (i + 1) + '조 ' + esc(s.heading || '') + '</h2>'
              + (s.body || []).map(function (p) { return '<p class="legal-p">' + esc(p) + '</p>'; }).join('')
              + '</section>';
          }).join('');
    })
    .catch(function () {
      root.innerHTML = '<div class="legal-empty"><p class="legal-empty-title">문서를 불러오지 못했습니다.</p>'
        + '<p class="legal-empty-sub">잠시 후 새로고침해 주세요.</p></div>';
    });
})();
