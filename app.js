const EMOJI_FALLBACK = { goditor:'✦', godiv:'🖼', goshot:'📸', reviewcrawler:'🔍', focusflow:'⏱', clipboardpro:'📋', quietmode:'🔕', batteryguard:'🔋', swiftlaunch:'🚀', nightshiftpro:'🌙' };
const RECENT_VIDEOS = [
  { title:'맥 앱 혼자 만들기 — 처음부터 배포까지', date:'2026-03-20' },
  { title:'1인 개발자가 마케팅하는 법', date:'2026-03-13' },
  { title:'SwiftUI로 사이드바 앱 만들기', date:'2026-03-06' },
  { title:'유튜브 + 개발 병행 6개월 후기', date:'2026-02-27' },
];

async function loadApps() {
  // hidden:true 앱은 메인페이지에서 숨긴다(지우지 않음 — apps.json에서 hidden 제거하면 되살아난다).
  const apps = (await fetch('data/apps.json?v=20260903j').then(r=>r.json())).filter(a => !a.hidden);

  // Hero pills — 개별 stagger: 0.78s 기준, 0.08s 간격
  const bobDurations = [3.5, 4.0, 3.7, 4.1, 3.6, 3.9];
  // ★요소가 없으면 조용히 지나간다 — 히어로 앱버튼 절을 주석 처리해도 안 죽는다.
  const heroEl = document.getElementById('hero-apps');
  if (heroEl) heroEl.innerHTML = apps.map((app, i) => {
    // ★comingSoon 앱은 «주소 자체를 안 준다» — href 를 지우면 새 탭·주소복사·크롤러까지 막힌다.
    //   (2026-09-01 현빈: 「버튼뿐 아니라 해당 페이지로 이동도 안 되게」)
    const soon = !!app.comingSoon;
    const href = soon ? '' : (app.detailUrl || app.buyUrl || app.downloadUrl || '#apps');
    const delay = (0.78 + i * 0.08).toFixed(2);
    return `
    <a class="hero-app-pill${soon ? ' is-soon' : ''}"${soon ? ` role="link" aria-disabled="true" data-soon="${app.name}"` : ` href="${href}"`} style="animation-delay:${delay}s;">
      <div class="hero-app-pill-icon">
        <img src="${app.icon}" alt="${app.name}"
             onerror="this.parentElement.textContent='${EMOJI_FALLBACK[app.id]||'📦'}'" />
      </div>
      <span class="hero-app-pill-name">${app.name}</span>
    </a>`;
  }).join('');

  // 진입 완료 후 floatBob 시작 (마지막 pill: 0.78+0.40+0.45 ≈ 1.63s + 여유 200ms)
  setTimeout(() => {
    document.querySelectorAll('.hero-app-pill').forEach((pill, i) => {
      pill.style.animationDuration = bobDurations[i % bobDurations.length] + 's';
      pill.style.animationDelay = (i * 0.2).toFixed(1) + 's';
      pill.classList.add('bob-ready');
    });
  }, 1850);

  // ★프로덕트 섹션을 주석 처리해도 안 죽는다.
  const gridEl = document.getElementById('app-grid');
  if (gridEl) gridEl.innerHTML = apps.map(app=>`
    <a class="app-card card-hidden${app.comingSoon ? ' is-soon' : ''}"${app.comingSoon ? ` role="link" aria-disabled="true" data-soon="${app.name}"` : ` href="${app.detailUrl||app.buyUrl||app.downloadUrl||'#'}"`}>
      <div class="app-icon"><img src="${app.icon}" alt="${app.name}" onerror="this.parentElement.textContent='${EMOJI_FALLBACK[app.id]||'📦'}'" /></div>
      <div class="app-info">
        <div class="app-name">${app.name}</div>
        <div class="app-tagline">${app.tagline}</div>
        <div class="app-footer"><span class="app-badge">${app.comingSoon ? '준비 중' : (app.badge||(app.price==='free'?'free':'paid'))}</span>${app.version ? `<span class="app-ver">v${app.version}</span>` : ''}<span class="app-arrow">${app.comingSoon ? '' : '→'}</span></div>
      </div>
    </a>`).join('');
  initEntrance('.card-hidden', 'card-visible', 0.1, 70);
}

function loadVideos() {
  // ★요소가 없으면 «조용히» 지나간다 — 절을 주석 처리해도 TypeError 로 뒤 코드가 안 죽는다.
  //   (「없는 id 참조」로 결제 퍼널이 통째로 끊겼던 전례가 있다 — login.html UL-005 주석)
  const list = document.getElementById('yt-list');
  if (!list) return;
  list.innerHTML = RECENT_VIDEOS.map(v=>`
    <li class="yt-item yt-hidden"><span class="yt-title">${v.title}</span><span class="yt-date">${v.date}</span></li>`).join('');
  initEntrance('.yt-hidden', 'yt-visible', 0.2, 50);
}

function initEntrance(hiddenSelector, visibleClass, threshold, staggerMs) {
  const els = document.querySelectorAll(hiddenSelector);
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      const el = entry.target;
      const i = parseInt(el.dataset.entranceIndex, 10);
      setTimeout(() => {
        el.classList.remove(hiddenSelector.slice(1));
        el.classList.add(visibleClass);
      }, i * staggerMs);
      observer.unobserve(el);
    });
  }, { threshold, rootMargin: '0px 0px -30px 0px' });

  els.forEach((el, i) => {
    el.dataset.entranceIndex = i;
    observer.observe(el);
  });
}

// 메인 카피 waver — 진입 후 2.5s 대기, 이후 6~8s 간격으로 간헐 발동
function scheduleWave() {
  const delay = Math.random() * 2000 + 6000;
  setTimeout(() => {
    const line1 = document.querySelector('.title-line-1');
    const line2 = document.querySelector('.title-line-2');
    if (!line1 || !line2) return;
    line1.classList.add('title-waving');
    line1.addEventListener('animationend', () => line1.classList.remove('title-waving'), { once: true });
    setTimeout(() => {
      line2.classList.add('title-waving');
      line2.addEventListener('animationend', () => {
        line2.classList.remove('title-waving');
        scheduleWave();
      }, { once: true });
    }, 180);
  }, delay);
}
setTimeout(scheduleWave, 2500);

loadApps();
loadVideos();

/* ── 준비 중 앱 클릭 안내 (현빈 2026-09-01) ─────────────────────────
   ★두 겹으로 막는다:
     ⑴ 카드/필에 href 를 «안 준다» — 새 탭·주소복사·크롤러까지 막힌다(app.js 렌더부)
     ⑵ 그래도 주소를 직접 치고 들어오면 그 페이지에서 되돌린다(각 페이지 head 의 가드)
   토스트를 쓴 이유: 모달은 «닫기»를 요구해 한 번 더 일을 시킨다. 안내만 하면 되는 자리다. */
function showSoonToast(name) {
  var prev = document.querySelector('.soon-toast');
  if (prev) prev.remove();
  var t = document.createElement('div');
  t.className = 'soon-toast';
  t.setAttribute('role', 'status');
  // ★조사를 «쓰지 않는» 문구로 둔다.
  //   「은(는)」 은 자리표시자가 그대로 보였고, 「는」 으로 박으면 GOSHOT(고샷)처럼
  //   받침 있는 이름에서 틀린다. 영문 이름은 «글자 읽기»(티)와 «브랜드 읽기»(샷)가
  //   달라 규칙으로 맞출 수 없다 — 앱이 늘 때마다 틀리느니 조사를 없앤다.
  t.textContent = (name ? name + ' — ' : '') + '아직 준비 중입니다.';
  document.body.appendChild(t);
  requestAnimationFrame(function () { t.classList.add('on'); });
  setTimeout(function () {
    t.classList.remove('on');
    setTimeout(function () { t.remove(); }, 260);
  }, 2400);
}
/* 위임 — 나중에 그려지는 카드에도 걸린다 */
document.addEventListener('click', function (e) {
  var el = e.target.closest && e.target.closest('[data-soon]');
  if (!el) return;
  e.preventDefault();
  showSoonToast(el.getAttribute('data-soon'));
});

/* 준비 중 페이지에서 되돌아온 경우 — 왜 튕겼는지 알려준다 */
(function () {
  try {
    var n = sessionStorage.getItem('soon');
    if (n) { sessionStorage.removeItem('soon');
      window.addEventListener('DOMContentLoaded', function () { showSoonToast(n); }); }
  } catch (e) {}
})();
