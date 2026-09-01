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

/**
 * ★배포 배지 — 지금 보고 있는 게 «라이브가 아니면» 화면 위에 띠를 띄운다.
 *   프리뷰를 라이브로 착각해서 「반영됐네」라고 판단하는 사고를 막는다.
 *   production 이면 아무것도 그리지 않는다.
 */
(function () {
  // ★개발 배포 배너용이다. 프로덕션엔 이 엔드포인트가 없어 «전 페이지 콘솔에 404»가 찍혔고,
  //   진짜 에러를 덮었다. 라이브 도메인에서는 부르지 않는다(배너가 필요한 곳은 vercel·로컬뿐).
  if (/(^|\.)blacksheepwall\.kr$/.test(location.hostname)) return;
  fetch('/api/env', { cache: 'no-store' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (e) {
      if (!e || e.env === 'production') return;
      var bar = document.createElement('div');
      bar.textContent = '개발 배포 (' + e.env + (e.branch ? ' · ' + e.branch : '') + ' · DB ' + e.db + ')';
      bar.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:9999;'
        + 'background:#C9F23A;color:#0B0B0E;font:600 12px/1 Inter,sans-serif;'
        + 'padding:7px 12px;text-align:center;letter-spacing:.02em';
      document.body.appendChild(bar);
      document.body.style.paddingTop = '26px';
    })
    .catch(function () {});
})();
