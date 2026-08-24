/* /api/license/godiv-use — 위 api/godiv/use.js 와 «같은 핸들러»의 예비 주소.
 *
 * ★왜 두 주소인가 (2026-08-25)
 *   라이브(EC2)에서 «새 폴더»(api/godiv/*)가 라우팅에 물리는지는 배포 쪽(지디 트랙)이 정한다.
 *   확장은 이미 /api/godiv/banner 를 부르고 있는데 그 주소는 지금 404 다 — 같은 사고를 반복하지 않으려고
 *   «확실히 도는 폴더»(api/license/*)에도 같은 문을 낸다. 확장은 404 면 이쪽으로 한 번 더 시도한다.
 *
 * ⛔로직을 여기에 복사하지 마라. 두 벌이 되면 한쪽만 고치는 사고가 난다.
 */
module.exports = require('../godiv/use.js');
