/**
 * 「지금 보고 있는 게 어느 배포인가」 — 화면 배지의 근거.
 *
 * ★이게 없으면 프리뷰를 라이브로 착각한다. 오늘 하루에만 «로컬만 보고 배포됐다고 판단»하는
 *   사고를 두 번 봤다(드라이브 표기·워크트리 vs 라이브). 사람 기억에 안 기대게 서버가 말하게 한다.
 * ⚠️ 접속정보(MONGO_URI)는 «절대» 내보내지 않는다. 어느 DB 를 보는지 «이름»만 준다.
 */
const { DB_NAME } = require('./_lib/mongo');

module.exports = (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify({
    env: process.env.VERCEL_ENV || 'unknown',      // production | preview | development
    branch: process.env.VERCEL_GIT_COMMIT_REF || '',
    commit: (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 7),
    db: DB_NAME,
  }));
};
