/* 구글 버튼을 «한 곳에서» 만들어 꽂는다.
 *
 * ★왜 각 페이지에 SVG 를 붙여넣지 않나
 *   버튼이 가입·로그인 두 곳(나중에 더)에 들어간다. 붙여넣으면 시안을 바꿀 때마다
 *   여러 파일을 고쳐야 하고, 한 곳을 빠뜨리면 «페이지마다 다른 버튼»이 된다.
 *
 * 쓰는 법  <div class="gsi-slot" data-google-btn></div>  +  <script src="google-btn.js?v=…">
 *   선택 속성  data-next="/mypage.html"   로그인 뒤 돌아갈 «우리 사이트 경로»
 *
 * ⛔로고 SVG 를 고치지 마라 — 구글 브랜딩 가이드의 «지정 자산»이다.
 */
(function () {
  'use strict';

  // 구글 공식 4색 G. 색값·비율 모두 지정값이다.
  var LOGO =
    '<svg viewBox="0 0 48 48" aria-hidden="true" focusable="false">'
    + '<path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>'
    + '<path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>'
    + '<path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>'
    + '<path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>'
    + '</svg>';

  /* ★문구는 가입·로그인이 «같다».
     구글이 계정 유무에 따라 알아서 가르기 때문에 「가입」이라고 쓰면 틀린 말이 된다. */
  var LABEL = 'Google로 계속하기';

  function mount(slot) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'gsi-btn';
    btn.innerHTML = LOGO + '<span>' + LABEL + '</span>';

    btn.addEventListener('click', function () {
      btn.disabled = true;
      /* ★목적지는 «경로만» 넘긴다 — 서버가 호스트를 못 받게 되어 있다(오픈 리디렉터 차단).
         값이 이상하면 서버가 400 으로 끊는다. 여기서 조용히 고쳐 보내지 않는다. */
      var next = slot.getAttribute('data-next') || '';
      var url = '/api/license/google-start?app=web'
        + (next ? '&redirect=' + encodeURIComponent(next) : '');
      window.location.href = url;
    });

    slot.appendChild(btn);

    // 「또는」 구분선 — 버튼이 실제로 붙었을 때만 만든다.
    var or = document.createElement('div');
    or.className = 'auth-or';
    or.textContent = '또는';
    slot.parentNode.insertBefore(or, slot.nextSibling);
  }

  function init() {
    var slots = document.querySelectorAll('[data-google-btn]');
    for (var i = 0; i < slots.length; i++) mount(slots[i]);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
