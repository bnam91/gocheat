/* mail-template.js — 트랜잭션 메일 HTML 한 벌.
 *
 * ★관행 조사(2026-09-02): 받은편지함의 실제 메일을 뜯어봤다.
 *   Anthropic·Google·Vercel·Notion 전부 ⑴<table> 레이아웃 ⑵인라인 스타일 위주
 *   ⑶최대폭 480~630px ⑷웹폰트 미사용(Google 제외) ⑸HTML+plain 멀티파트.
 *   다크모드 미디어쿼리는 Vercel 만 썼다 — 우리는 «사이트가 다크 기본»이라 넣는다.
 *
 * ★왜 table 인가: Outlook(Word 렌더러)은 flex·grid 를 모르고 margin 도 자주 무시한다.
 *   div 로 짜면 «어떤 사람에게는» 레이아웃이 통째로 무너지는데, 그걸 우리가 볼 방법이 없다.
 * ★왜 인라인 스타일인가: Gmail 은 <style> 을 «지우지는» 않지만 일부 클라이언트가 지운다.
 *   구조·색은 인라인으로 두고, <style> 은 «있으면 좋은 것»(다크모드)만 담는다.
 * ★왜 웹폰트를 안 쓰나: 사이트는 Inter 지만 메일에서 웹폰트는 대부분 차단된다.
 *   폴백이 결국 시스템 폰트이므로 처음부터 시스템 스택으로 간다.
 * ★왜 로고가 «텍스트»인가: 이미지는 기본 차단되는 클라이언트가 많다.
 *   차단된 상태에서도 「누가 보냈는지」가 보여야 한다.
 *
 * ★버튼 글자색 — 사이트와 «다르게» 간다(근거 있음).
 *   사이트 라이트 테마는 라임(#80C322) 위에 흰 글자를 쓴다(현빈 확정). 그런데 그 조합은
 *   대비 2.15:1 로 본문 기준(4.5:1) 미달이다. 화면에서는 «주변 맥락»이 읽기를 돕지만
 *   메일은 클라이언트마다 렌더가 달라 그 여유가 없다. 먹 글자로 두면 9.12:1(라이트)·
 *   15.2:1(다크) 로 둘 다 안전하다. ⇒ 메일에서만 먹 글자.
 */

// 사이트 style.css 의 토큰을 그대로 옮긴 값. 한 곳에서만 고친다.
const C = {
  // ★라이트 버튼은 «먹색»이다(2026-09-02 현빈 지시, 사이트 --accent-fill 과 같은 값).
  //   글자는 흰색 — 19.65:1. 다크는 라임 위 먹 글자 그대로(15.2:1).
  light: { bg: '#FFFFFF', card: '#F4F4F6', fg: '#0B0B0E', muted: '#4B4B54',
           subtle: '#6B6B74', border: '#E3E3E7', accent: '#0B0B0E', btnInk: '#FFFFFF' },
  dark:  { bg: '#0B0B0E', card: '#15151A', fg: '#F2F2F5', muted: '#B5B5BC',
           subtle: '#8E8E96', border: '#26262C', accent: '#C9F23A', btnInk: '#0B0B0E' },
};
// ★버튼 글자색이 테마마다 다르다 — 라이트는 «먹 버튼 위 흰 글자», 다크는 «라임 버튼 위 먹 글자».
//   한 값으로 묶으면 한쪽이 반드시 안 보인다.
const INK = '#FFFFFF';
const MONO = "'JetBrains Mono','Fira Code',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";
const FONT = "-apple-system,BlinkMacSystemFont,'Apple SD Gothic Neo','Malgun Gothic','Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif";

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * @param {object}   o
 * @param {string}   o.label     카드 상단 «모노 대문자» 라벨 — 사이트의 .hero-badge 관습
 * @param {string}   o.title     큰 제목(한 줄)
 * @param {string[]} o.paragraphs 본문 문단
 * @param {object=}  o.cta       { label, url } — 없으면 버튼 없음
 * @param {string[]=} o.notes    작은 글씨 안내(버튼 아래)
 * @param {string=}  o.rawUrl    버튼이 안 눌릴 때를 위한 «주소 그대로» 표시
 * @param {string=}  o.code      라이센스 키처럼 «그대로 복사해야 하는» 값
 */
function renderMail({ label = '소문의섬', title, paragraphs = [], cta = null, notes = [], rawUrl = null, code = null }) {
  const L = C.light;
  const p = (t) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.7;color:${L.muted};">${esc(t)}</p>`;
  const note = (t) => `<p style="margin:0 0 6px;font-size:13px;line-height:1.6;color:${L.subtle};">${esc(t)}</p>`;

  // ★버튼은 «table 셀»로 만든다(bulletproof). a 태그에 padding 만 주면 Outlook 이 무시해
  //   글자만 덩그러니 남는다 — 사용자는 누를 곳을 못 찾는다.
  // ★버튼은 «table 셀»로 만든다(bulletproof). a 태그에 padding 만 주면 Outlook 이 무시해
  //   글자만 덩그러니 남는다 — 사용자는 누를 곳을 못 찾는다.
  // ★★폭을 «채운다». 현빈 지적: 버튼 바로 아래 64자 토큰 URL 이 두 줄을 차지해서
  //   버튼이 «장식»처럼 보였다. 버튼을 크게 하고 URL 은 아래 구분선 밖으로 뺀다.
  const button = cta ? `
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 4px;">
          <tr><td class="btn" align="center" bgcolor="${L.accent}" style="border-radius:10px;">
            <a href="${esc(cta.url)}" style="display:block;padding:15px 24px;font-family:${FONT};font-size:16px;font-weight:700;letter-spacing:-0.01em;color:${INK};text-decoration:none;border-radius:10px;">${esc(cta.label)} &nbsp;→</a>
          </td></tr>
        </table>` : '';

  // ★키·코드는 «고정폭»으로 크게 둔다 — 사람이 눈으로 옮겨 적는 값이라
  //   0/O, 1/l 이 구분돼야 한다. 그리고 줄바꿈이 끼면 붙여넣기가 깨지므로 통째로 감싼다.
  const codeBox = code ? `
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:18px 0 4px;">
          <tr><td class="card" align="center" bgcolor="${L.bg}" style="background:${L.bg};border:1px solid ${L.border};border-radius:10px;padding:16px 12px;">
            <span class="fg" style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:17px;font-weight:700;letter-spacing:0.06em;color:${L.fg};word-break:break-all;">${esc(code)}</span>
          </td></tr>
        </table>` : '';

  // ★★raw URL 은 «버튼이 안 될 때만» 필요한 것이다. 버튼 바로 밑에 두면
  //   64자 토큰이 두 줄을 잡아먹어 «버튼과 무관한 덩어리»처럼 보인다(현빈 지적).
  //   ⇒ 구분선 아래 «안내 영역»으로 내리고 글씨를 한 단계 더 줄인다.
  const raw = rawUrl ? `
          <p style="margin:0 0 4px;font-size:12px;line-height:1.6;color:${L.subtle};">버튼이 안 눌리면 아래 주소를 붙여넣어 주세요.</p>
          <p class="rawurl" style="margin:0 0 12px;font-family:${MONO};font-size:11px;line-height:1.55;color:${L.subtle};word-break:break-all;">${esc(rawUrl)}</p>` : '';

  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="color-scheme" content="light dark" /><meta name="supported-color-schemes" content="light dark" />
<title>${esc(title)}</title>
<style>
  /* ★다크모드는 «있으면 좋은 것»이다 — 이 블록이 지워져도 라이트 인라인 스타일로 멀쩡히 읽힌다. */
  @media (prefers-color-scheme: dark) {
    .bg    { background:${C.dark.bg} !important; }
    .card  { background:${C.dark.card} !important; border-color:${C.dark.border} !important; }
    .fg    { color:${C.dark.fg} !important; }
    .muted { color:${C.dark.muted} !important; }
    .subtle, .subtle a, .rawurl, .label { color:${C.dark.subtle} !important; }
    .btn   { background:${C.dark.accent} !important; }
    .btn a { color:${C.dark.btnInk} !important; }
    .hr, .rule { border-color:${C.dark.border} !important; }
    .accentbar { background:${C.dark.accent} !important; }
    .codebox   { background:${C.dark.bg} !important; border-color:${C.dark.border} !important; }
  }
  @media (max-width: 620px) { .wrap { width:100% !important; } .pad { padding:26px 20px !important; } }
</style></head>
<body class="bg" style="margin:0;padding:0;background:${L.bg};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="bg" style="background:${L.bg};">
    <tr><td align="center" style="padding:32px 16px 40px;">
      <table role="presentation" class="wrap" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;font-family:${FONT};">

        <!-- ── 브랜드 밴드 — 사이트 헤더(로고 + 얇은 하단선)를 그대로 옮겼다.
             ★로고는 «이미지가 아니라 텍스트»다: 이미지는 기본 차단되는 클라이언트가 많고,
               차단된 상태에서도 「누가 보냈는지」가 보여야 한다. ── -->
        <tr><td style="padding:0 2px 12px;">
          <span class="fg" style="font-size:17px;font-weight:700;letter-spacing:-0.02em;color:${L.fg};">소문의섬</span>
        </td></tr>
        <tr><td class="rule" style="border-top:1px solid ${L.border};font-size:0;line-height:0;">&nbsp;</td></tr>
        <!-- ★라임 액센트 바 — 사이트의 시그니처 색을 «구조»로 쓴다. 글자색으로만 쓰면
             브랜드가 안 남는다(현빈 지적: 「우리 디자인·브랜딩 느낌이 있으면 좋겠다」). -->
        <tr><td><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
          <td class="accentbar" bgcolor="${L.accent}" width="56" height="3" style="background:${L.accent};width:56px;height:3px;font-size:0;line-height:0;">&nbsp;</td>
        </tr></table></td></tr>

        <tr><td class="card pad" style="background:${L.card};border:1px solid ${L.border};border-top:0;border-radius:0 0 12px 12px;padding:28px 28px 26px;">

          <!-- ★모노 라벨 — 사이트 .hero-badge 관습(JetBrains Mono)을 따르되 «자간은 줄였다».
               사이트 값(letter-spacing .06em + uppercase)은 «영문 대문자» 전제라, 한글에 그대로 쓰면
               「비밀번호  재설정」처럼 낱자가 벌어져 어색해진다. uppercase 도 한글엔 효과가 없다.
               ★그리고 «모노 서체»도 뺐다 — JetBrains Mono 는 메일에서 로드되지 않아 시스템 고정폭으로
               폴백되는데, 한글을 고정폭으로 그리면 낱자 사이가 더 벌어져 오히려 나빠진다.
               ⇒ 브랜드는 «라임 바 + 로고»가 지고, 라벨은 «읽기»를 택했다.
               (모노는 라이센스 키처럼 «사람이 눈으로 옮겨 적는 값»에만 남겼다 — 거기선 0/O 구분이 필요하다) -->
          <p class="label" style="margin:0 0 10px;font-size:13px;font-weight:600;letter-spacing:0.01em;color:${L.subtle};">${esc(label)}</p>

          <h1 class="fg" style="margin:0 0 16px;font-size:21px;line-height:1.4;font-weight:700;letter-spacing:-0.01em;color:${L.fg};">${esc(title)}</h1>
          <div class="muted">${paragraphs.map(p).join('')}</div>
          ${button}
          ${codeBox}
          ${notes.length ? `<hr class="hr" style="border:0;border-top:1px solid ${L.border};margin:22px 0 14px;" /><div class="subtle">${notes.map(note).join('')}</div>` : ''}
          ${rawUrl ? `<hr class="hr" style="border:0;border-top:1px solid ${L.border};margin:16px 0 12px;" />${raw}` : ''}
        </td></tr>

        <tr><td class="subtle" style="padding:20px 4px 0;font-size:12px;line-height:1.7;color:${L.subtle};">
          이 메일은 발신 전용입니다. 문의는 <a href="mailto:coq3820@gmail.com" style="color:${L.subtle};">coq3820@gmail.com</a> 으로 보내주세요.<br />
          상호: 소문의섬 · 개인정보보호책임자: 소문의섬 운영자<br />
          <a href="https://blacksheepwall.kr" style="color:${L.subtle};">blacksheepwall.kr</a> ·
          <a href="https://blacksheepwall.kr/terms.html" style="color:${L.subtle};">이용약관</a> ·
          <a href="https://blacksheepwall.kr/privacy.html" style="color:${L.subtle};">개인정보 처리방침</a>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body></html>`;
}

module.exports = { renderMail };
