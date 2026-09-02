#!/usr/bin/env python3
"""mail-send.py — 본문을 «파일»에서 읽어 Gmail API 로 보낸다.

★왜 따로 만드나
  gmail_manager.py 는 본문을 `--body "…"` 로 받는다. 그러면 «재설정 링크»가
  프로세스 명령줄에 실려 `ps` 로 누구에게나 보인다 — 그 링크 하나면 계정에 들어간다.
  ⇒ 본문은 «파일»로만 넘긴다(0600). 인증은 gmail_manager 의 것을 그대로 재사용한다.

사용: mail-send.py --account 별칭 --to a@b.c --subject 제목 --body-file /경로
"""
import argparse, base64, os, sys
from email.mime.text import MIMEText

GM = os.path.expanduser("~/Documents/claude_skills/gmail_manager")
sys.path.insert(0, GM)
os.chdir(GM)                      # get_service 가 상대경로로 토큰을 찾는다
from gmail_manager import get_service, load_config   # noqa: E402


def resolve(alias):
    for a in load_config().get("accounts", []):
        if a.get("alias") == alias:
            return a["email"]
    raise SystemExit(f"[오류] 별칭 '{alias}' 을 config 에서 못 찾음")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--account", required=True)
    p.add_argument("--to", required=True)
    p.add_argument("--subject", required=True)
    p.add_argument("--body-file", required=True)
    a = p.parse_args()

    with open(a.body_file, encoding="utf-8") as f:
        body = f.read()

    sender = resolve(a.account)
    msg = MIMEText(body, "plain", "utf-8")
    # ★헤더 이름은 RFC 상 대소문자 무관이지만 «관례»는 대문자다.
    #   소문자로 넣었더니 우리 읽기 도구가 Subject 로만 찾아 「제목 없음」으로 표시했다.
    #   보내는 쪽이 관례를 따르는 편이 안전하다(스팸 필터·구형 클라이언트).
    msg["To"], msg["From"], msg["Subject"] = a.to, sender, a.subject
    raw = base64.urlsafe_b64encode(msg.as_bytes()).decode()
    r = get_service(sender).users().messages().send(userId="me", body={"raw": raw}).execute()
    # ⛔본문·링크는 찍지 않는다. 확인 가능한 «식별자»만 낸다.
    print("sent id=" + r.get("id", "?"))


if __name__ == "__main__":
    main()
