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

  fetch('data/business.json?v=20260904k')
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
 * 저작권 표기 — 푸터 맨 아래.
 * ★business.json 과 «분리»한다: 저작권은 사업자정보가 아니라 «항상 있어야 하는» 것이라,
 *   그 파일을 못 읽어도(또는 값이 비어도) 반드시 떠야 한다. 위 IIFE 의 fetch 에 묶으면
 *   네트워크가 한 번 실패할 때 저작권까지 같이 사라진다.
 * ★연도는 «한국 시간» 기준으로 뽑는다 — 보는 사람의 시간대에 따라 연말·연초에
 *   1년이 어긋나 보이면 안 된다(이 프로젝트의 날짜 규범과 같다).
 */
(function () {
  var kstYear = new Date(Date.now() + 9 * 3600 * 1000).getUTCFullYear();
  var text = '\u00A9 ' + kstYear + ' 소문의섬. All rights reserved.';

  // ★저작권과 연락처 메일을 «한 줄»에 둔다(현빈 2026-09-02).
  //   메일 주소는 «마크업»에 그대로 둔다 — Cloudflare 가 HTML 안의 메일 주소만
  //   난독화(__cf_email__)해 준다. 여기서 JS 로 그려 넣으면 그 보호가 사라져
  //   수집 봇에게 평문으로 노출된다. 그래서 «저작권만» 여기서 채운다.
  var span = document.getElementById('footer-copy');
  if (span) { span.textContent = text; return; }

  // 예전 마크업(#footer-copy 없음) 대비 — 없으면 전처럼 한 줄 덧붙인다.
  var slot = document.getElementById('biz-info');
  if (!slot || !slot.parentNode) return;
  var p = document.createElement('p');
  p.className = 'footer-meta';
  p.textContent = text;
  slot.parentNode.appendChild(p);
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
