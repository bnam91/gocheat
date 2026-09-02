/**
 * GODITOR 다운로드 버튼 — 플랫폼 판별·주소·버전 배지·내려받기 기록.
 *
 * ★주소의 단 한 벌은 data/downloads.json 이다(서버도 같은 파일을 본다).
 * ★버전은 그 파일에서만 온다 — 못 읽으면 «안 그린다». 낡은 값이 보이는 일이 없다.
 * 2026-09-02: goditor.html 인라인에서 분리.
 */
// 다운로드 — 누르면 «바로» 드라이브로 간다. 로그인도, 서버도 필요 없다.
    //
    // ★2026-08-07 구조 전환. 전에는 <button> 이 /api/license/download 로 주소를
    //   «받아와서» window.open 했다. 그런데 그 API 는 아무것도 막지 않는다
    //   (드라이브 폴더가 링크 공개라 원래 게이트가 아니었다). 막는 게 없는데
    //   API 가 죽으면 다운로드만 죽는다 — 순손실이다. 실제로 그랬다:
    //     프리뷰(python http.server) POST → 501,  미배포 라이브 → 404
    //   그러면 r.json() 이 깨져 «지금은 연결이 어려워요» 회색 한 줄만 남는다.
    //   현빈 눈에는 «눌러도 아무 일도 안 일어난다»로 보였다. 맞는 지적이었다.
    //
    // ★그래서 이동은 <a href> 가 하고, 이 스크립트는 «주소를 정교하게 만드는» 일만 한다.
    //   기록은 곁다리로 쏘고 결과를 «기다리지 않는다» — 기록 실패가 이동을 막으면 안 된다.
    //
    // ★플랫폼을 감지하되 «칩은 단정하지 않는다».
    //   맥은 ARM64/Intel 로 갈리는데 브라우저로 구분할 방법이 없다.
    //   그래서 ARM64 를 기본으로 «제시»하고 Intel 경로를 항상 나란히 둔다 —
    //   틀려도 사용자가 한 번에 고칠 수 있다.
    (function () {
var btn   = document.getElementById('download-btn');
var alt   = document.getElementById('dl-alt');
var intel = document.getElementById('dl-intel');
var mac   = document.getElementById('dl-mac');
if (!btn) return;

var ua = navigator.userAgent || '';
var isWin = /Windows/i.test(ua);
var isMac = /Mac OS X|Macintosh/i.test(ua) && !/iPhone|iPad/i.test(ua);

var LABEL = { 'mac-arm64': 'macOS 버전 다운로드', 'win': 'Windows 버전 다운로드', '': '다운로드' };
var platform = isMac ? 'mac-arm64' : (isWin ? 'win' : '');
// ★textContent 로 덮으면 안에 넣은 버전 조각까지 지워진다 — 라벨만 담는 span 을 둔다.
btn.innerHTML = '';
var lbl = document.createElement('span');
lbl.className = 'dl-btn-label';
lbl.textContent = LABEL[platform];
btn.appendChild(lbl);

// 맥이면 칩 안내를 «먼저» 보여준다. 주소는 이미 마크업에 있으니
// downloads.json 을 못 읽어도 링크는 산다.
if (isMac && mac) { mac.hidden = false; alt.hidden = false; }

// 주소의 단 한 벌은 data/downloads.json 이다(서버도 같은 파일을 본다).
// 못 읽으면 마크업의 기본 주소가 그대로 남는다 — 아무 데도 못 가는 상태가 없다.
fetch('data/downloads.json?v=20260903k')
  .then(function (r) { return r.ok ? r.json() : null; })
  .then(function (d) {
    var u = d && d.goditor;
    if (!u) return;
    if (u[platform]) btn.href = u[platform];
    if (intel && u['mac-intel']) intel.href = u['mac-intel'];

    // ★버전은 «여기서만» 온다. 마크업에 기본값을 안 박았으므로
    //   못 읽으면 이 조각이 아예 안 그려진다 — 낡은 값이 보이는 일이 구조적으로 없다.
    //   (현빈: «현재 홈페이지에 실제로 올라가 있는 파일»의 버전이어야 한다)
    if (typeof u.version === 'string' && u.version) {
      // 버튼 «안»에 붙인다(현빈 2026-09-02). 못 읽으면 이 조각이 아예 안 생기므로
      // 낡은 버전이 보이는 일은 여전히 구조적으로 없다.
      var vb = document.createElement('span');
      vb.className = 'dl-btn-ver';
      vb.textContent = 'v' + u.version;
      btn.appendChild(vb);
    }
  })
  .catch(function () { /* 기본 주소로 간다. 버전은 안 그린다 */ });

// ★기록은 «곁다리»다. 로그인한 사람만 세고, 결과를 기다리지 않는다.
//   (비회원은 원래도 세지 않았다 — 익명 카운트는 오염된다)
function log(pf) {
  var email, token;
  try {
    email = sessionStorage.getItem('sms_email');
    token = sessionStorage.getItem('sms_token');
  } catch (e) { return; }
  if (!email || !token) return;
  try {
    fetch('/api/license/download', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      keepalive: true,   // 탭이 바뀌어도 요청이 끊기지 않게
      body: JSON.stringify({ email: email, sessionToken: token, app: 'goditor', platform: pf }),
    }).catch(function () {});
  } catch (e) { /* 기록 실패는 삼킨다 — 이동을 막지 않는다 */ }
}

btn.addEventListener('click', function () { log(platform); });
if (intel) intel.addEventListener('click', function () { log('mac-intel'); });
    })();
