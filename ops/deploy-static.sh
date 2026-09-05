#!/usr/bin/env bash
# 정적 배포 — 「파일 복사」와 「마커 기록」과 「검사」를 «한 동작»으로 묶는다
#
# ★왜 스크립트로 만드나 (2026-09-05)
#   이 사이트는 EC2 에 «.git 이 없다». 그래서 배포는 손으로 파일을 밀고, DEPLOY_SHA 도
#   손으로 적는 방식이었다. 둘이 따로 노니까 하나만 해도 아무도 안 막는다 —
#   실제로 DEPLOY_SHA 가 108 커밋(사흘) 동안 틀린 값을 말하고 있었다.
#   ⇒ 「앞으로 잘 적겠다」는 대책이 아니다. «따로 할 수 없게» 묶는 것이 대책이다.
#
# 사용:
#   ops/deploy-static.sh                  # ★기본 = 예행연습. 무엇이 바뀔지 보여주고 «안» 밀어낸다
#   ops/deploy-static.sh --yes            # 실제 배포 (origin/main HEAD)
#   ops/deploy-static.sh --sha <sha> --yes
#
# ⛔배포는 현빈 게이트다. --yes 는 «승인을 받은 뒤에» 붙인다.
set -euo pipefail

SSH_KEY="${HP_SSH_KEY:-$HOME/.config/aws-wp-keys/oneulpost-v2}"
SSH_HOST="${HP_SSH_HOST:-ec2-user@100.67.191.40}"
DOCROOT="${HP_DOCROOT:-/opt/goditor-api}"
SHA="$(git rev-parse origin/main)"
APPLY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --yes) APPLY=1; shift ;;
    --sha) SHA="$(git rev-parse --verify "$2^{commit}")"; shift 2 ;;
    *) echo "모르는 인자: $1" >&2; exit 2 ;;
  esac
done

SHORT="$(git rev-parse --short "$SHA")"
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=15 -i "$SSH_KEY" "$SSH_HOST")

echo "배포 대상 커밋: $SHORT ($(git log -1 --format='%s' "$SHA"))"

# ★서버가 «지금» 무엇이라고 주장하는지부터 적어 둔다 — 되돌릴 때 이 값이 필요하다
PREV="$("${SSH[@]}" "cat $DOCROOT/DEPLOY_SHA 2>/dev/null || echo NONE" | tr -d '\r\n')"
echo "서버 현재 마커: $PREV"

# ★마커가 «믿을 수 있는지» 먼저 검사한다. 못 믿을 값이면 「무엇이 바뀌나」도 거짓말이 된다
if [ "$PREV" != "NONE" ] && git rev-parse --verify -q "$PREV^{commit}" >/dev/null; then
  if node "$(dirname "$0")/verify-deploy.mjs" >/dev/null 2>&1; then
    echo "현재 마커 검사: ✓ 믿을 수 있다 — 아래 «바뀔 파일»도 정확하다"
    echo ""
    echo "── 바뀔 파일 ──"
    git diff --stat "$PREV..$SHA" -- . ':!api' ':!ops' ':!scripts' ':!docs' ':!server' || true
  else
    echo "현재 마커 검사: ⚠️어긋난다 — 서버 실물이 $PREV 와 다르다."
    echo "  ⇒ 「무엇이 바뀌나」를 커밋 비교로 답할 수 없다. 먼저 원인을 보고해라:"
    echo "     node ops/verify-deploy.mjs"
  fi
else
  echo "⚠️서버 마커가 없거나 이 레포에 없는 커밋이다 — 변경 범위를 계산할 수 없다."
fi

if [ "$APPLY" -ne 1 ]; then
  echo ""
  echo "예행연습이라 아무것도 밀지 않았다. 실제로 하려면 --yes 를 붙여라 (⛔현빈 승인 후)."
  exit 0
fi

# ── 실제 배포 ────────────────────────────────────────────────
STAGE="$(mktemp -d)"; trap 'rm -rf "$STAGE"' EXIT
# ★«작업 트리»가 아니라 «커밋»에서 꺼낸다 — 로컬에 굴러다니는 수정본이 섞이지 않게
git archive "$SHA" | tar -x -C "$STAGE"

TS="$(date +%Y%m%d-%H%M%S)"
echo ""
echo "백업: $DOCROOT → /home/ec2-user/hp-backup-$TS (정적 파일만)"
"${SSH[@]}" "mkdir -p /home/ec2-user/hp-backup-$TS && cd $DOCROOT && \
  tar cf /home/ec2-user/hp-backup-$TS/static.tar \
    --exclude=node_modules --exclude=api --exclude=server --exclude=bin --exclude=scripts \
    . 2>/dev/null || true"

echo "전송 중…"
# ★api/ server/ 등 «서버 코드»는 이 스크립트가 건드리지 않는다. 정적 배포와 API 배포는
#   위험도도 롤백 방법도 다르다 — 한 스크립트에 묶으면 둘 다 무서워서 아무도 안 쓴다.
rsync -az --delete-after \
  --include='*/' \
  --include='*.html' --include='*.css' --include='*.js' --include='*.mjs' \
  --include='assets/***' --include='data/*.json' \
  --exclude='*' \
  --exclude='node_modules/' --exclude='api/' --exclude='server/' --exclude='bin/' \
  --exclude='scripts/' --exclude='ops/' --exclude='docs/' \
  -e "ssh -i $SSH_KEY" "$STAGE/" "$SSH_HOST:$DOCROOT/"

# ★마커는 «파일을 민 다음에, 같은 실행 안에서» 적는다. 이 순서가 전부다.
echo "$SHA" | "${SSH[@]}" "sudo tee $DOCROOT/DEPLOY_SHA >/dev/null"

echo ""
echo "── 배포 후 검사 ──"
# ★여기서 실패하면 «배포가 실패한 것»이다. 성공 메시지를 먼저 찍지 않는 이유다.
if node "$(dirname "$0")/verify-deploy.mjs"; then
  echo ""
  echo "✓ 배포 완료 · 마커 $SHORT · 백업 /home/ec2-user/hp-backup-$TS/static.tar"
else
  echo ""
  echo "✗ 배포 후 검사 실패 — 마커와 실물이 어긋난다. 배포를 «성공으로 치지 마라»."
  echo "  되돌리려면: tar xf /home/ec2-user/hp-backup-$TS/static.tar -C $DOCROOT"
  exit 1
fi
