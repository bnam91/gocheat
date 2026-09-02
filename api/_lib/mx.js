const dns = require('dns').promises;

/**
 * 「이 도메인이 메일을 받을 수 있는가」를 DNS 로 확인한다.
 *
 * ★왜 필요한가: 양식 검사는 «모양»만 본다. gmail.comm 처럼 존재하지 않는 도메인도
 *   양식은 완벽하다. 그런 주소로 가입하면 인증메일·비밀번호 재설정이 영영 도달하지 않고,
 *   사용자는 «자기가 뭘 잘못했는지» 모른 채 갇힌다.
 *
 * ★판정 규칙(RFC 5321 §5.1)
 *   ⑴ MX 레코드가 있으면 받는다.
 *   ⑵ MX 가 없어도 A/AAAA 가 있으면 «암묵적 MX» 로 그 호스트가 받는다 — 통과시켜야 한다.
 *   ⑶ 둘 다 없으면(NXDOMAIN·ENODATA) 그 도메인은 메일을 못 받는다.
 *
 * ★★실패했을 때는 «통과»시킨다(fail open).
 *   DNS 가 느리거나 우리 쪽 네트워크가 흔들리는 건 «사용자 잘못이 아니다».
 *   여기서 막으면 멀쩡한 사람의 가입이 우리 사정으로 거절된다.
 *   확실한 「없음」 답을 받았을 때만 막는다.
 *
 * ⚠️이 검사가 «못 잡는» 것: gmial.com 처럼 «실재하는» 오타 도메인. A 레코드가 있어
 *   규격상 메일을 받을 수 있으므로 통과한다. 그건 인증메일로만 걸러진다.
 */

// ★★예약 도메인 예외(현빈 2026-09-02 선택).
//   RFC 2606·6761 이 「절대 실재하지 않는다」고 못박은 TLD 들이다 — 그래서 DNS 가 «반드시» 없다고 답한다.
//   우리 개발·QA 계정 9건이 @goya.test 를 쓰고 있어, 막으면 «우리 테스트가» 먼저 막힌다.
//   ⚠️대가를 적어 둔다: 이 예외 때문에 「메일이 도달하지 않는 주소로도 가입이 된다」는 구멍이
//     코드에 남는다. 진짜 손님은 이 TLD 를 쓸 수 없으므로 실사용 위험은 없지만,
//     ★유료 판매를 켤 때는 이 목록을 다시 볼 것 — 그때는 «테스트도 실도메인»으로 옮기는 게 맞다.
const RESERVED_TLDS = ['test', 'example', 'invalid', 'localhost'];
function isReserved(domain) {
  const d = String(domain || '').toLowerCase();
  return RESERVED_TLDS.some((t) => d === t || d.endsWith('.' + t));
}

const TIMEOUT_MS = 2500;          // ★가입 흐름 안에서 도는 검사다 — 오래 잡고 있으면 그게 더 나쁘다
const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map();          // domain → { ok, at }

function withTimeout(p) {
  return Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('dns_timeout'), { code: 'ETIMEOUT' })), TIMEOUT_MS)),
  ]);
}

async function domainAcceptsMail(domain) {
  const d = String(domain || '').trim().toLowerCase();
  if (!d) return { ok: false, reason: 'empty' };

  if (isReserved(d)) return { ok: true, reason: 'reserved_tld' };

  const hit = cache.get(d);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return { ok: hit.ok, cached: true, reason: hit.reason };

  let ok = null, reason = '';
  try {
    const mx = await withTimeout(dns.resolveMx(d));
    // ★빈 배열이거나 '.' 하나(=null MX, RFC 7505 「이 도메인은 메일을 안 받는다」)면 못 받는다
    const usable = (mx || []).filter((r) => r && r.exchange && r.exchange !== '.');
    if (usable.length) { ok = true; reason = 'mx'; }
  } catch (e) {
    if (e && (e.code === 'ETIMEOUT' || e.code === 'ESERVFAIL' || e.code === 'ETIMEOUT')) {
      // ★답을 «못 받은» 것이지 「없다」는 답이 아니다 — 통과시킨다.
      cache.set(d, { ok: true, at: Date.now(), reason: 'dns_unavailable' });
      return { ok: true, unknown: true, reason: 'dns_unavailable' };
    }
    // ENOTFOUND / ENODATA 는 «없다는 답»이다 — 아래 A 조회로 한 번 더 본다.
  }

  if (ok === null) {
    try {
      const a = await withTimeout(dns.resolve4(d));
      if (a && a.length) { ok = true; reason = 'a_record'; }
    } catch (e) {
      try {
        const aaaa = await withTimeout(dns.resolve6(d));
        if (aaaa && aaaa.length) { ok = true; reason = 'aaaa_record'; }
      } catch (e2) {
        if (e2 && e2.code === 'ETIMEOUT') {
          cache.set(d, { ok: true, at: Date.now(), reason: 'dns_unavailable' });
          return { ok: true, unknown: true, reason: 'dns_unavailable' };
        }
      }
    }
  }

  if (ok === null) { ok = false; reason = 'no_mx_no_a'; }
  cache.set(d, { ok, at: Date.now(), reason });
  return { ok, reason };
}

async function emailDomainAcceptsMail(email) {
  const at = String(email || '').lastIndexOf('@');
  if (at < 1) return { ok: false, reason: 'no_domain' };
  return domainAcceptsMail(String(email).slice(at + 1));
}

module.exports = { domainAcceptsMail, emailDomainAcceptsMail };
