#!/usr/bin/env node
/* mail-drain.mjs — 메일 큐의 «발송 쪽» 절반. 맥에서 돈다.
 *
 * ★구조: DB 는 EC2, Gmail 자격증명은 맥. 둘 중 어느 것도 «옮기지 않는다».
 *   맥이 이미 가진 SSH 키로 EC2 의 mailq.js 를 불러 큐를 집고, 보내는 일만 여기서 한다.
 *   ⇒ 서버에 메일함 권한이 안 올라가고, 맥에 DB 접속정보가 안 내려온다.
 *
 * ⛔로그 규칙(④): 수신자는 마스킹하고, «본문과 링크는 어떤 경우에도 찍지 않는다».
 *   재설정 링크가 로그에 남으면 그 로그를 읽는 사람에게 계정탈취 도구를 주는 것이다.
 *
 * 사용: node mail-drain.mjs [--once]
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SSH = ['-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=15',
             '-i', process.env.HOME + '/.config/aws-wp-keys/oneulpost-v2', 'ec2-user@100.67.191.40'];
const REMOTE = 'sudo bash -c \'set -a; . /etc/goditor-api/env; set +a; node /home/ec2-user/opstools/mailq.js';
const SENDER = new URL('./mail-send.py', import.meta.url).pathname;   // 본문을 «파일»로 받는 발송기
const ACCOUNT = '현빈개인메일';                       // coq3820@gmail.com (gmail.send 권한 보유)

const mask = (e) => String(e).replace(/^(..)[^@]*@/, '$1***@');
const log  = (...a) => console.log(new Date().toISOString().slice(0, 19), ...a);

function ssh(args) {
  const out = execFileSync('ssh', [...SSH, `${REMOTE} ${args}'`], { encoding: 'utf8', timeout: 60000 });
  // ssh 배너(WARNING …)가 섞여 들어온다 — JSON/토큰만 남긴다
  return out.split('\n').filter((l) => !l.startsWith('**')).join('\n').trim();
}

function sendMail(to, subject, body, html) {
  // ★★본문을 명령줄 인자로 넘기면 «프로세스 목록»에 재설정 링크가 실린다 — ps 로 누구나 본다.
  //   그 링크 하나면 계정에 들어간다. ⇒ 본문은 «파일»로만 넘기고(0600) 즉시 지운다.
  const dir = mkdtempSync(join(tmpdir(), 'mdrain-'));
  const f = join(dir, 'body.txt');
  try {
    writeFileSync(f, body, { mode: 0o600 });
    const args = [SENDER, '--account', ACCOUNT, '--to', to, '--subject', subject, '--body-file', f];
    if (html) {
      const hf = join(dir, 'body.html');
      writeFileSync(hf, html, { mode: 0o600 });   // ★HTML 에도 링크가 들어 있다 — 같은 이유로 파일로만
      args.push('--html-file', hf);
    }
    execFileSync('python3', args,
      { encoding: 'utf8', timeout: 90000, env: { ...process.env, PYTHONUTF8: '1' } });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

async function drain() {
  const swept = ssh('sweep');
  if (swept && swept !== '0') log(`만료 마감 ${swept}건`);

  const claimed = JSON.parse(ssh('claim 5') || '[]');
  if (!claimed.length) return 0;
  log(`집음 ${claimed.length}건`);

  let ok = 0;
  for (const m of claimed) {
    try {
      sendMail(m.to, m.subject, m.body, m.html);   // ⛔m.body·m.html 을 로그에 찍지 않는다
      ssh(`done ${m.id}`);
      log(`  발송 ${mask(m.to)} — ${m.subject}`);
      ok++;
    } catch (e) {
      const why = String(e && e.message || e).replace(/https?:\/\/\S+/g, '<링크가림>').slice(0, 110);
      const r = ssh(`fail ${m.id} "${why.replace(/"/g, "'")}"`);
      log(`  ★실패 ${mask(m.to)} (${r}) — ${why}`);
    }
  }
  return ok;
}

drain().then((n) => { if (n) log(`완료 ${n}건`); }).catch((e) => {
  log('★드레인 오류:', String(e && e.message).replace(/https?:\/\/\S+/g, '<링크가림>').slice(0, 160));
  process.exitCode = 1;
});
