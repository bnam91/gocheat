const { getDb } = require('../_lib/mongo');

function html(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(body);
}

function page(title, message) {
  return `<!doctype html>
<html lang="ko"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title} · 소문의섬</title>
<style>
  body { margin:0; background:#0B0B0E; color:#EAEAF0; font-family:Inter,-apple-system,system-ui,sans-serif;
    display:flex; align-items:center; justify-content:center; min-height:100vh; padding:24px; }
  .card { max-width:420px; text-align:center; }
  h1 { font-size:24px; font-weight:700; margin:0 0 12px; }
  p { color:#A6A6B5; line-height:1.6; margin:0 0 24px; }
  a { color:#C8FF6A; text-decoration:none; }
</style>
</head><body><div class="card">
  <h1>${title}</h1>
  <p>${message}</p>
  <p><a href="/">← 소문의섬 홈으로</a></p>
</div></body></html>`;
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') return html(res, 405, page('잘못된 요청', '잘못된 요청 방법입니다.'));

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const token = url.searchParams.get('token');
  if (!token || !/^[a-f0-9]{32,128}$/i.test(token)) {
    return html(res, 400, page('잘못된 링크', '인증 토큰이 올바르지 않습니다.'));
  }

  try {
    const db = await getDb();
    const users = db.collection('users');
    const now = new Date();

    const user = await users.findOne({ verificationToken: token });
    if (!user) {
      return html(res, 404, page('이미 인증되었거나 만료됨', '이 링크는 이미 사용되었거나 유효하지 않습니다. 다시 가입을 시도해주세요.'));
    }
    if (user.verificationTokenExpiresAt && user.verificationTokenExpiresAt < now) {
      return html(res, 410, page('인증 링크 만료', '인증 링크가 만료되었습니다. 가입 페이지에서 다시 시도해주세요.'));
    }

    await users.updateOne(
      { _id: user._id },
      {
        $set: { verified: true, verifiedAt: now, updatedAt: now },
        $unset: { verificationToken: '', verificationTokenExpiresAt: '' },
      },
    );

    return html(res, 200, page('이메일 인증 완료', '이제 라이센스를 발급받을 수 있어요. 앱에서 로그인 후 다운로드해주세요.'));
  } catch (err) {
    console.error('[verify] error', err);
    return html(res, 500, page('서버 오류', '잠시 후 다시 시도해주세요.'));
  }
};
