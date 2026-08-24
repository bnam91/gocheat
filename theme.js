// 다크/라이트 토글. 실제 테마 결정은 head 인라인 부트스크립트가 먼저 한다
// (FOUC 방지, 이 스크립트는 body 끝에서 늦게 실행된다) — 여기는 토글 버튼 배선과
// meta[theme-color] 동기화만 한다.
(function () {
  var KEY = 'sms_theme';
  var root = document.documentElement;
  var META_COLOR = { dark: '#0B0B0E', light: '#FFFFFF' };

  function systemPrefersLight() {
    return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches);
  }

  function resolvedTheme() {
    var explicit = root.getAttribute('data-theme');
    if (explicit === 'light' || explicit === 'dark') return explicit;
    return systemPrefersLight() ? 'light' : 'dark';
  }

  function syncMetaColor(theme) {
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', META_COLOR[theme] || META_COLOR.dark);
  }

  function syncButtons(theme) {
    var btns = document.querySelectorAll('.theme-toggle');
    for (var i = 0; i < btns.length; i++) {
      btns[i].setAttribute('aria-pressed', theme === 'light' ? 'true' : 'false');
      btns[i].setAttribute('aria-label', theme === 'light' ? '다크 모드로 전환' : '라이트 모드로 전환');
    }
  }

  function apply(theme) {
    root.setAttribute('data-theme', theme);
    syncMetaColor(theme);
    syncButtons(theme);
  }

  // 최초 진입 — 부트스크립트/시스템 설정이 이미 정한 상태를 그대로 반영(깜빡임 없이)
  apply(resolvedTheme());

  var btns = document.querySelectorAll('.theme-toggle');
  for (var i = 0; i < btns.length; i++) {
    btns[i].addEventListener('click', function () {
      var next = resolvedTheme() === 'light' ? 'dark' : 'light';
      try { localStorage.setItem(KEY, next); } catch (e) { /* 저장 불가 환경 — 이 세션만 반영 */ }
      apply(next);
    });
  }

  // 명시 선택이 없는 사용자만 — OS 설정이 바뀌면 실시간 반영
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', function () {
      var stored = null;
      try { stored = localStorage.getItem(KEY); } catch (e) {}
      if (stored !== 'light' && stored !== 'dark') apply(resolvedTheme());
    });
  }
})();
