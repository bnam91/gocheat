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
  light: { bg: '#FFFFFF', card: '#F4F4F6', fg: '#0B0B0E', muted: '#4B4B54',
           subtle: '#6B6B74', border: '#E3E3E7', accent: '#80C322' },
  dark:  { bg: '#0B0B0E', card: '#15151A', fg: '#F2F2F5', muted: '#B5B5BC',
           subtle: '#8E8E96', border: '#26262C', accent: '#C9F23A' },
};
const INK = '#0B0B0E';      // 라임 위 글자 — 두 테마 공통
const FONT = "-apple-system,BlinkMacSystemFont,'Apple SD Gothic Neo','Malgun Gothic','Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif";

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * @param {object}   o
 * @param {string}   o.title     큰 제목(한 줄)
 * @param {string[]} o.paragraphs 본문 문단
 * @param {object=}  o.cta       { label, url } — 없으면 버튼 없음
 * @param {string[]=} o.notes    작은 글씨 안내(버튼 아래)
 * @param {string=}  o.rawUrl    버튼이 안 눌릴 때를 위한 «주소 그대로» 표시
 * @param {string=}  o.code      라이센스 키처럼 «그대로 복사해야 하는» 값
 */
function renderMail({ title, paragraphs = [], cta = null, notes = [], rawUrl = null, code = null }) {
  const L = C.light;
  const p = (t) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.7;color:${L.muted};">${esc(t)}</p>`;
  const note = (t) => `<p style="margin:0 0 6px;font-size:13px;line-height:1.6;color:${L.subtle};">${esc(t)}</p>`;

  // ★버튼은 «table 셀»로 만든다(bulletproof). a 태그에 padding 만 주면 Outlook 이 무시해
  //   글자만 덩그러니 남는다 — 사용자는 누를 곳을 못 찾는다.
  const button = cta ? `
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:22px 0 8px;">
          <tr><td class="btn" align="center" bgcolor="${L.accent}" style="border-radius:10px;">
            <a href="${esc(cta.url)}" style="display:inline-block;padding:13px 26px;font-family:${FONT};font-size:15px;font-weight:700;color:${INK};text-decoration:none;border-radius:10px;">${esc(cta.label)}</a>
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

  const raw = rawUrl ? `
        <p style="margin:10px 0 0;font-size:12px;line-height:1.6;color:${L.subtle};">
          버튼이 안 눌리면 아래 주소를 브라우저에 붙여넣어 주세요.<br />
          <span class="rawurl" style="color:${L.muted};word-break:break-all;">${esc(rawUrl)}</span>
        </p>` : '';

  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="color-scheme" content="light dark" /><meta name="supported-color-schemes" content="light dark" />
<title>${esc(title)}</title>
<style>
  /* ★다크모드는 «있으면 좋은 것»이다 — 이 블록이 지워져도 라이트 인라인 스타일로 멀쩡히 읽힌다. */
  @media (prefers-color-scheme: dark) {
    .bg   { background:${C.dark.bg} !important; }
    .card { background:${C.dark.card} !important; border-color:${C.dark.border} !important; }
    .fg   { color:${C.dark.fg} !important; }
    .muted, .rawurl { color:${C.dark.muted} !important; }
    .subtle, .subtle a { color:${C.dark.subtle} !important; }
    .btn  { background:${C.dark.accent} !important; }
    .hr   { border-color:${C.dark.border} !important; }
  }
  @media (max-width: 620px) { .wrap { width:100% !important; } .pad { padding:24px 20px !important; } }
</style></head>
<body class="bg" style="margin:0;padding:0;background:${L.bg};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="bg" style="background:${L.bg};">
    <tr><td align="center" style="padding:32px 16px;">
      <table role="presentation" class="wrap" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;font-family:${FONT};">

        <!-- 워드마크 — ★이미지가 아니라 텍스트다(이미지 차단돼도 보인다) -->
        <tr><td style="padding:0 0 18px;">
          <span class="fg" style="font-size:17px;font-weight:800;letter-spacing:-0.01em;color:${L.fg};">소문의섬</span>
        </td></tr>

        <tr><td class="card pad" style="background:${L.card};border:1px solid ${L.border};border-radius:12px;padding:30px 28px;">
          <h1 class="fg" style="margin:0 0 16px;font-size:20px;line-height:1.45;font-weight:700;color:${L.fg};">${esc(title)}</h1>
          <div class="muted">${paragraphs.map(p).join('')}</div>
          ${button}
          ${codeBox}
          ${raw}
          ${notes.length ? `<hr class="hr" style="border:0;border-top:1px solid ${L.border};margin:20px 0 14px;" /><div class="subtle">${notes.map(note).join('')}</div>` : ''}
        </td></tr>

        <tr><td class="subtle" style="padding:18px 4px 0;font-size:12px;line-height:1.7;color:${L.subtle};">
          이 메일은 발신 전용입니다. 문의는 <a href="mailto:coq3820@gmail.com" style="color:${L.subtle};">coq3820@gmail.com</a> 으로 보내주세요.<br />
          상호: 소문의섬 · 개인정보보호책임자: 소문의섬 운영자<br />
          <a href="https://blacksheepwall.kr/terms.html" style="color:${L.subtle};">이용약관</a> ·
          <a href="https://blacksheepwall.kr/privacy.html" style="color:${L.subtle};">개인정보 처리방침</a>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body></html>`;
}

module.exports = { renderMail };
