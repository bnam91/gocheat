/**
 * 푸터 사업자정보 렌더러 — 전 페이지 공용.
 *
 * data/business.json 한 곳만 채우면 5개 페이지에 동시에 반영된다.
 * ★값이 비어 있으면 «아무것도 그리지 않는다».
 *   확인되지 않은 사업자정보를 자리표시자로 노출하면 허위 표기가 되기 때문이다.
 *   (2026-08-06: 자리표시자 대표자명·사업자등록번호가 들어간 초안이 있어 이식하지 않았다)
 */
(function () {
  const slot = document.getElementById('biz-info');
  if (!slot) return;

  const LABELS = [
    ['companyName',     '상호'],
    ['ceo',             '대표'],
    ['bizNo',           '사업자등록번호'],
    ['mailOrderNo',     '통신판매업 신고번호'],
    ['privacyOfficer',  '개인정보보호책임자'],
    ['address',         '주소'],
    ['phone',           '대표전화'],
    ['email',           '이메일'],
  ];

  fetch('data/business.json')
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (biz) {
      if (!biz) return;

      const parts = LABELS
        .filter(function (pair) { return String(biz[pair[0]] || '').trim(); })
        .map(function (pair) { return pair[1] + ': ' + String(biz[pair[0]]).trim(); });

      if (!parts.length) return; // 값 없음 → 렌더하지 않는다

      const p = document.createElement('p');
      p.className = 'footer-biz';
      parts.forEach(function (text, i) {
        if (i) {
          const sep = document.createElement('span');
          sep.className = 'footer-biz-sep';
          sep.textContent = '|';
          p.appendChild(sep);
        }
        // 항목 단위로 감싼다 — 안 그러면 "제0000-지 / 역-00000호" 처럼 값 중간에서 줄이 끊긴다
        const item = document.createElement('span');
        item.className = 'footer-biz-item';
        item.textContent = text;
        p.appendChild(item);
      });
      slot.appendChild(p);
    })
    .catch(function () { /* 사업자정보는 보조 정보 — 실패해도 페이지는 정상 동작 */ });
})();
