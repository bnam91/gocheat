const EMOJI_FALLBACK = { focusflow:'⏱', clipboardpro:'📋', quietmode:'🔕', batteryguard:'🔋', swiftlaunch:'🚀', nightshiftpro:'🌙' };
const RECENT_VIDEOS = [
  { title:'맥 앱 혼자 만들기 — 처음부터 배포까지', date:'2026-03-20' },
  { title:'1인 개발자가 마케팅하는 법', date:'2026-03-13' },
  { title:'SwiftUI로 사이드바 앱 만들기', date:'2026-03-06' },
  { title:'유튜브 + 개발 병행 6개월 후기', date:'2026-02-27' },
];

async function loadApps() {
  const apps = await fetch('data/apps.json').then(r=>r.json());

  // Hero pills — 개별 stagger: 0.78s 기준, 0.08s 간격
  const bobDurations = [3.5, 4.0, 3.7, 4.1, 3.6, 3.9];
  document.getElementById('hero-apps').innerHTML = apps.map((app, i) => {
    const href = app.detailUrl || app.buyUrl || app.downloadUrl || '#apps';
    const delay = (0.78 + i * 0.08).toFixed(2);
    return `
    <a class="hero-app-pill" href="${href}" style="animation-delay:${delay}s;">
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

  document.getElementById('app-grid').innerHTML = apps.map(app=>`
    <a class="app-card card-hidden" href="${app.detailUrl||app.buyUrl||app.downloadUrl||'#'}">
      <div class="app-icon"><img src="${app.icon}" alt="${app.name}" onerror="this.parentElement.textContent='${EMOJI_FALLBACK[app.id]||'📦'}'" /></div>
      <div class="app-info">
        <div class="app-name">${app.name}</div>
        <div class="app-tagline">${app.tagline}</div>
        <div class="app-footer"><span class="app-badge">${app.badge||(app.price==='free'?'free':'paid')}</span><span class="app-arrow">→</span></div>
      </div>
    </a>`).join('');
  initEntrance('.card-hidden', 'card-visible', 0.1, 70);
}

function loadVideos() {
  document.getElementById('yt-list').innerHTML = RECENT_VIDEOS.map(v=>`
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
