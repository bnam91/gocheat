const { json, setCors, handlePreflight } = require('../_lib/util');

/* 원격 동시협업 — «함수 하나»가 7개 경로를 받는다.
 *
 * ★왜 합쳤나 (2026-08-15)
 *   Vercel Hobby 플랜의 서버리스 «함수» 상한이 12개다. api/ 아래 파일 하나가 함수 하나로 센다.
 *   env(1) + license(9) + collab(7) = 17 → 상한 초과로 preview 배포가 4연속 실패했다.
 *   ⇒ 협업 7개를 이 파일 «하나»로 받고, 핸들러 본문은 api/_lib/collab-handlers/ 로 옮겼다.
 *     ★_ 로 시작하는 경로는 Vercel 이 함수로 «세지 않는다» — 그래서 17 → 11 이 된다.
 *   ⛔유료 업그레이드로 푸는 문제가 아니다(현빈·지디 확정). 함수를 늘리려면 여기부터 다시 세라.
 *
 * ★URL 은 «하나도 안 바뀐다». 동적 라우트라 /api/collab/register … /api/collab/pull 그대로다.
 *   앱이 이미 그 7개 경로로 부르고 있다 — 경로를 바꾸면 앱을 다시 배포해야 한다.
 *
 * ★분기는 «화이트리스트»다. req.query.action 을 그대로 함수 이름처럼 쓰면
 *   임의 문자열로 내부 모듈을 부르는 길이 열린다. 아래 표에 «있는 것만» 부른다.
 *   표는 Object.create(null) 로 만든다 — 평범한 객체면 'constructor' 같은 이름이
 *   프로토타입 체인에서 «찾아져» 화이트리스트를 통과한다.
 */
const ROUTES = Object.create(null);
ROUTES.register = require('../_lib/collab-handlers/register');
ROUTES.invite = require('../_lib/collab-handlers/invite');
ROUTES.invites = require('../_lib/collab-handlers/invites');
ROUTES.respond = require('../_lib/collab-handlers/respond');
ROUTES.leave = require('../_lib/collab-handlers/leave');
ROUTES.push = require('../_lib/collab-handlers/push');
ROUTES.pull = require('../_lib/collab-handlers/pull');

/* action 은 Vercel 이 req.query 에 넣어준다.
 * ★URL 에서 직접 뽑는 «폴백»을 둔다 — 로컬 하네스·다른 런타임에는 query 파서가 없다.
 *   여기서 조용히 undefined 가 되면 모든 요청이 404 가 되고, 원인이 안 보인다. */
function resolveAction(req) {
  const q = req.query && typeof req.query.action === 'string' ? req.query.action : '';
  if (q) return q;
  const url = typeof req.url === 'string' ? req.url : '';
  const last = url.split('?')[0].split('/').filter(Boolean).pop() || '';
  return last;
}

module.exports = async (req, res) => {
  const action = resolveAction(req);
  const handler = ROUTES[action];

  if (typeof handler !== 'function') {
    // preflight 는 «모르는 경로»에서도 CORS 규칙대로 답한다(브라우저가 먼저 묻는 요청이다).
    if (handlePreflight(req, res, { origin: '*' })) return;
    setCors(res, { origin: '*' });
    // ★404 에도 JSON 본문을 낸다 — 본문 없는 404 를 앱은 「미배포」로 읽는다.
    return json(res, 404, { ok: false, reason: 'unknown_action' });
  }

  return handler(req, res);
};
