/* /api/license/report-list — «../report/list.js» 와 같은 핸들러의 예비 주소.
 *
 * ★왜 두 주소인가 (api/license/godiv-use.js 와 같은 이유, 2026-08-25 선례)
 *   정본 주소는 /api/report/list.js 계열이지만, EC2 어댑터(server/ec2-server.js)가 «새 폴더»를 라우팅하려면
 *   패치가 필요하다. 그 패치가 안 실린 배포에서는 정본 주소가 404 다 — 확장이 /api/godiv/banner 에서
 *   정확히 그 사고를 겪었다.
 *   ⇒ «확실히 도는 폴더»(api/license/*)에도 같은 문을 낸다. 앱은 정본을 먼저 부르고 404 면 이쪽으로 재시도한다.
 *
 * ⛔로직을 여기에 복사하지 마라. 두 벌이 되면 한쪽만 고치는 사고가 난다.
 */
module.exports = require('../report/list.js');
