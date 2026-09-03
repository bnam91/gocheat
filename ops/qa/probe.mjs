/**
 * 홈페이지 QA — «페이지 한 장을 재는 법» 정본.
 *
 * ★★이 파일의 값어치는 «검사 항목»이 아니라 «거짓 경보를 안 내는 법»에 있다.
 *   2026-09-03 하루에 검사기가 여섯 번 거짓말을 했고, 그 여섯을 여기 박아 뒀다.
 *   ⛔아래 가드를 지우지 마라 — 지우면 그날의 헛수고를 그대로 반복한다.
 */

/** ① 페이지가 «잴 준비»가 될 때까지 기다린다. */
export const WAIT = `(() => {
  // ★애니메이션이 «끝나기 전»에 재면 opacity 0.3 을 보고 「요소가 안 보인다」고 오판한다.
  //   ⚠️반복 애니메이션(waver 등)은 영원히 안 끝난다 — 그건 기다리면 안 된다.
  //   ⚠️«지연 시작»(delay) 애니메이션은 이 검사 시점에 아직 running 이 아니라 그냥 통과한다.
  //     그래서 호출부가 «최소 대기»를 따로 준다(아래 MIN_SETTLE).
  return document.getAnimations()
    .filter(a => a.playState === 'running' && (a.effect?.getTiming?.().iterations || 1) !== Infinity)
    .length;
})()`;
// ★지연 시작 애니메이션이 «시작할» 만큼만 기다린다(실측: reveal 은 0.5~1.5s 사이에 끝난다).
//   이 값을 더 줄이면 §4-1 거짓 경보가 돌아온다. 더 늘리면 러너가 느려져 «안 쓰게» 된다.
//   ⇒ 700ms 로 시작을 잡고, 끝나는 것은 WAIT(getAnimations) 가 기다린다.
export const MIN_SETTLE = 700;

/** ② 한 페이지에서 «사람이 겪는 문제»만 뽑는다. */
export const PROBE = `(() => {
  const vis = (e) => {
    const c = getComputedStyle(e);
    // ★display:contents 는 «자기 박스가 없다» — 폭 0 이 정상이다(.ext-block 로 한 번 당했다).
    if (c.display === 'none' || c.visibility === 'hidden' || c.display === 'contents') return false;
    if (e.closest('[hidden]')) return false;
    let n = e.parentElement;
    while (n && n !== document.body) {
      const cc = getComputedStyle(n);
      if (cc.display === 'none' || cc.visibility === 'hidden') return false;
      n = n.parentElement;
    }
    return true;
  };
  // ★클래스가 없는 요소는 «글자 앞머리»로 부른다 — 「SPAN.(17px)」 로는 무엇인지 알 수 없다.
  const nm = (e) => {
    const cls = String(e.className || '').trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.');
    const txt = e.textContent.trim().replace(/\s+/g, ' ').slice(0, 14);
    return e.tagName + (cls ? '.' + cls : '') + (txt ? '「' + txt + '」' : '');
  };

  // ⛔«안 보이는 요소» — 보여야 하는데 안 보이는 것. 여기가 백지 사고를 잡는 자리다.
  const invisible = [...document.querySelectorAll('body *')].filter((e) => {
    if (!vis(e)) return false;
    if (!e.textContent.trim() && !e.querySelector('img,svg')) return false;
    const c = getComputedStyle(e), b = e.getBoundingClientRect();
    return parseFloat(c.opacity) === 0 || b.width === 0 || b.height === 0;
  }).map(nm);

  // ⛔«화면 밖으로 나간 것». ★가로 스크롤 컨테이너 «안»은 넘쳐도 정상이다(코드블록·표).
  const offscreen = [...document.querySelectorAll('body *')].filter((e) => {
    if (!vis(e)) return false;
    let n = e.parentElement;
    while (n && n !== document.body) {
      const cc = getComputedStyle(n);
      if (cc.overflowX === 'auto' || cc.overflowX === 'scroll') return false;
      n = n.parentElement;
    }
    const b = e.getBoundingClientRect();
    return b.width > 0 && (b.right > innerWidth + 2 || b.left < -2);
  }).map(nm);

  // ⛔«겹쳐서 못 읽는 글» — 글자 위에 다른 것이 덮인 자리
  const covered = [...document.querySelectorAll('h1,h2,h3,p,a,button,label')].filter((e) => {
    if (!vis(e)) return false;
    const b = e.getBoundingClientRect();
    if (b.width < 8 || b.height < 8 || b.top < 0 || b.top > innerHeight) return false;
    const top = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
    return top && top !== e && !e.contains(top) && !top.contains(e);
  }).map(nm);

  // ⛔«눌러도 아무 데도 안 가는 링크»
  const deadLinks = [...document.querySelectorAll('a[href]')]
    .filter((a) => vis(a) && /^\s*(#|javascript:)?\s*$/.test(a.getAttribute('href')) && !a.onclick)
    .map((a) => a.textContent.trim().slice(0, 16) || '(빈 링크)');

  // ⛔«대비가 낮아 못 읽는 글» — 배경을 거슬러 올라가 실제 뒷색을 찾는다
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
  const rgb = (s) => (s.match(/[\d.]+/g) || [0,0,0]).slice(0, 3).map(Number);
  const bgOf = (e) => { let n = e;
    while (n && n !== document.documentElement) {
      const c = getComputedStyle(n).backgroundColor;
      if (c && !/rgba\(0, 0, 0, 0\)|transparent/.test(c)) return rgb(c);
      n = n.parentElement; }
    return rgb(getComputedStyle(document.body).backgroundColor || 'rgb(255,255,255)'); };
  const lowContrast = [...document.querySelectorAll('h1,h2,h3,p,a,button,span,li,label')].filter((e) => {
    if (!vis(e)) return false;
    const own = [...e.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join('');
    if (own.length < 2) return false;
    const c = getComputedStyle(e);
    if (parseFloat(c.opacity) < 1) return false;
    // ★그라디언트 글자는 -webkit-text-fill-color: transparent 라 «color 가 실제 보이는 색이 아니다».
    //   그걸 재면 언제나 낮게 나온다(.gradient-text 로 실제 당했다). 여기서 뺀다.
    if (c.webkitTextFillColor && /transparent|rgba\(0, 0, 0, 0\)/.test(c.webkitTextFillColor)) return false;
    if (/text/.test(c.backgroundClip || '') || /text/.test(c.webkitBackgroundClip || '')) return false;
    const fg = rgb(c.color), bg = bgOf(e);
    const l1 = lum(fg), l2 = lum(bg);
    const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    const big = parseFloat(c.fontSize) >= 24 || (parseFloat(c.fontSize) >= 18.66 && parseInt(c.fontWeight) >= 700);
    return ratio < (big ? 3 : 4.5);
  }).map((e) => nm(e) + '(' + Math.round(parseFloat(getComputedStyle(e).fontSize)) + 'px)');

  return {
    invisible: [...new Set(invisible)].slice(0, 5),
    offscreen: [...new Set(offscreen)].slice(0, 5),
    covered:   [...new Set(covered)].slice(0, 5),
    deadLinks: [...new Set(deadLinks)].slice(0, 5),
    lowContrast: [...new Set(lowContrast)].slice(0, 5),
    hScroll: document.documentElement.scrollWidth > innerWidth,
    nav: [...document.querySelectorAll('.nav-links a')].filter((e) => e.offsetParent !== null).map((a) => a.textContent.trim()).join('·'),
    title: (document.querySelector('h1') || {}).textContent?.trim().slice(0, 20) || '',
    bodyLen: document.body.innerText.trim().length,
  };
})()`;
