/**
 * 휴대전화번호 정규화 — 화면 쪽 «단 하나»의 자리.
 *
 * ⛔2026-09-04: 서버가 이 일을 «네 곳에서 따로» 하다가 국가번호를 아무도 안 봐서
 *   「+82 로 가입한 사람이 비밀번호를 영영 못 찾는」 버그가 났다(api/_lib/util.js 주석 참조).
 *   ★그리고 화면에서도 «똑같이» 났다 — 가입폼과 이메일찾기가 숫자만 남기고 11자로 잘라서
 *     「+82 10-1111-0004」가 「82101111000」이라는 «없는 번호»가 됐다.
 *     휴대폰 자동완성·연락처 붙여넣기는 실제로 +82 형태를 준다.
 *   ⇒ 그래서 여기 «한 곳»에 둔다. 이 파일을 복사하지 마라.
 *
 * ★규칙은 서버(api/_lib/util.js normalizePhone)와 «같아야» 한다:
 *   «82 로 시작하고 그 다음이 0 이 아니면» 국가번호로 본다.
 *   국내 번호는 전부 0 으로 시작하므로(010·02·031…) 이 규칙이 국내 번호를 망가뜨리지 않는다.
 *     821011110004 → 01011110004 (휴대폰)
 *     82212345678  → 0212345678  (서울 유선)
 *     01011110004  → 그대로
 *   ⚠️한쪽만 고치면 다시 어긋난다. 규칙을 바꾸면 «두 파일을 같이» 고쳐라.
 */
(function (w) {
  'use strict';

  function normalizePhoneKR(v) {
    var d = String(v == null ? '' : v).replace(/[^0-9]/g, '');
    // ★자르기 «전»에 국가번호를 뗀다 — 순서가 바뀌면 82 를 남긴 채 뒤가 잘려 나간다.
    //   («82101111000» 사고가 정확히 이 순서 때문이었다)
    if (d.length >= 10 && d.slice(0, 2) === '82' && d.charAt(2) !== '0') {
      d = '0' + d.slice(2);
    }
    return d.slice(0, 11);
  }

  /**
   * 입력칸에 붙이는 «표시용» 정규화.
   * 사용자가 치는 중에도 돌기 때문에 «지우지 않는다» — 잘라내기만 한다.
   * ★값이 안 바뀌면 대입도 하지 않는다: 대입하면 커서가 맨 뒤로 튄다(중간 수정이 불가능해진다).
   */
  function bindPhoneInput(el) {
    if (!el) return;
    el.addEventListener('input', function () {
      var next = normalizePhoneKR(el.value);
      if (el.value !== next) el.value = next;
    });
  }

  w.normalizePhoneKR = normalizePhoneKR;
  w.bindPhoneInput = bindPhoneInput;
})(window);
