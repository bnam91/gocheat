# 배포 게이트 패키지 — 세션분리+사용통계+entitlements (EC2 반영 검토용)

> 2026-08-25 · 고디브매니저 작성 · ⛔**아직 배포 안 함. 지디 검토·GO 후 반영.** 이 문서가 「EC2 반영 직전 보고」 게이트다.
> 대성 08-25 배포 보고 양식 준용.

---

## 0. ★핵심 주의 — 나갈 것은 «entitlements 만»이 아니다

`feat/entitlements-per-app` 은 `feat/godiv-usage-and-per-app-session` 위에 쌓였다. main 대비 **7커밋 전부가 미배포**다:

```
a380b7b ③ 앱별 read + 운영자 승격 도구
bbf36d5 ② entitlements 스키마 additive
67f6265 세션 2차 재검수 10건
eab71bd 세션 엣지 6항목
b634765 세션 백필·원자성 + 방침문구
128a764 사용통계 1단계 (godiv_events)
f37e39b 세션 제품별 분리 + 사용기록
```

⚠️**entitlements 만 떼서 배포하면 깨진다** — login/session/use 가 `_lib/sessions.js`(제품별 세션)·`godiv_events` 를 전제한다. **이 라인은 통째로 나가야 한다.**

---

## 1. EC2 반영 대상 + main 머지 여부

- **대상 커밋** = `hompage_app` `feat/entitlements-per-app` tip = **a380b7b** (위 7커밋 포함).
- **main 머지 = ⛔안 한다 (EC2 경로).** 근거: hompage_app 은 Vercel GitHub App 훅이 살아 있어 **main push = Vercel 프로덕션 자동 재배포**(오늘 실측). 라이브 api 는 EC2(blacksheepwall.kr)이고 Vercel 은 예비다. ⇒ 대성 08-25 방식대로 **feature 브랜치에서 파일만 scp** 로 EC2 에 나른다. main 은 안 건드린다(예비 Vercel 을 의도치 않게 흔들지 않기 위해).
  - 별도 결정으로 main 머지를 원하면 그건 «Vercel 예비도 같이 갱신»한다는 뜻 — 그때 따로.

## 2. 바뀌는 파일 (api/ = EC2 서빙 대상)

수정 6 · 신규 4:
```
M api/_lib/collab.js       (findUserBySession 공용화 — 세션조회 일원화)
A api/_lib/entitlements.js (앱별 자격 단일진실)
M api/_lib/mongo.js        (인덱스 추가: sessions.token, godiv_events 3종+TTL)
A api/_lib/sessions.js     (제품별 세션 파이프라인)
A api/godiv/use.js         (사용기록 — ★새 폴더 api/godiv/)
M api/license/download.js  (effectiveFor 앱별)
A api/license/godiv-use.js (use.js 예비 별칭 — 아래 라우팅 주의)
M api/license/login.js     (entitlements 응답 + 앱별 만료)
M api/license/session.js   (entitlements 응답 + 앱별 만료)
M api/license/signup.js    (가입 시 entitlements 채움)
```

⚠️★**라우팅 확인 필수** — `api/godiv/` 는 «새 폴더»다. EC2 서버가 `api/godiv/*` 를 라우팅하지 않으면 `/api/godiv/use` 가 404 다(과거 banner 404 전례). 그래서 «확실히 도는 폴더»에 별칭 `api/license/godiv-use.js`(같은 핸들러 re-export)를 뒀고, 확장은 404 시 그리로 폴백한다. ⇒ **배포 시 ①api/godiv 라우팅을 여는 게 최선, ②안 되면 별칭 경로라도 반드시 올라가야** 사용기록이 안 샌다.

- 운영 스크립트(서버가 서빙 안 함, 운영자 실행용): `scripts/promote-entitlement.mjs`(승격), `scripts/backfill-sessions.mjs`(세션 백필). EC2 박스에 올려두면 운영자가 ssh 로 실행 가능. `scripts/test-*.mjs` 는 배포 불필요(개발 검증용).
- `vercel.json`(api/godiv maxDuration) 은 EC2 무관 — Vercel 경로 갈 때만 의미.

**백업/되돌리기** (대성 .pre-* 패턴):
- 반영 전 `api/` 를 `api.pre-entitlements-2026-08-25/` 로 통째 백업(또는 파일별 `.pre-*`).
- 되돌리기 한 줄: `cp -r /opt/goditor-api/api.pre-entitlements-2026-08-25/* /opt/goditor-api/api/ && (서버 리로드)`.
- DB 는 additive 라 롤백 시 되돌릴 스키마 변경 없음(entitlements 필드는 남아도 옛 코드가 안 읽으면 무해). 인덱스도 additive(createIndex, no-op 재실행).

## 3. 라이브 반영 «후» 검증 계획 (@goya.test 계정)

테스트 계정 = `goditor-ec2-test@goya.test` / `collab-test-b@goya.test` (⛔@goya.test 도메인만).

1. **옛앱 경로 회귀 0 (제일 중요)** — 구필드만 읽는 옛 배포본이 안 깨지는지:
   `POST /api/license/login {email, password}` → 응답에 **기존 필드 그대로**(`plan`, `accessUntil`, `sessionToken`) 존재 확인. 값이 이전과 동일.
2. **entitlements 추가 확인** — 같은 응답에 `entitlements.{goditor,goshot,godiv}` 가 «추가»로 실렸는지(기존 필드 대체 아님).
3. **세션 재검증** — `POST /api/license/session {sessionToken}` → `ok/plan/accessUntil` 유지 + `entitlements` 추가.
4. **사용기록 경로** — `POST /api/godiv/use`(또는 404 시 `/api/license/godiv-use`) 200 + `godiv_events` 1건 적재.
5. **승격 스모크(옵션)** — 테스트 계정에 `promote-entitlement.mjs --email goditor-ec2-test@goya.test --app godiv --forever --apply --prod` → session 응답의 `entitlements.godiv.plan=paid`, ★`goditor`·구필드 불변(교차오염 0) 라이브 확인. (테스트 계정에만)
6. **롤백 트리거** — 위 1(회귀)이 깨지면 즉시 .pre-* 복원.

> 자동화: 인메모리 몽고 51+16 항목은 로컬에서 이미 통과. 라이브는 «옛앱 회귀»와 «api/godiv 라우팅»만 실측하면 된다(그 둘은 환경 의존이라 로컬로 못 봄).

## 4. 웹스토어 제출분 = ★별 게이트 (EC2 뒤)

- `godiv-ext` `feat/entitlements-per-app`(74af997), 패키징 = 0.3.1 zip(store/godiv-ext-0.3.1.zip, 검증됨).
- ⛔**EC2 와 묶지 마라. EC2 가 먼저다** — 확장이 `entitlements` 응답을 읽으려면 서버가 먼저 나가 있어야 한다. 서버 없이 확장만 나가면 폴백(전역 plan)으로 돌 뿐 앱별 판매가 안 열린다.
- 웹스토어 제출은 별도 게이트1(제출 직전 정지·zip 해시/버전/아이콘 확인 후 보고).

## 5. 배포 순서 (확정 시)

1. EC2: `api/` 백업(.pre-*) → feature 브랜치에서 파일 scp → (라우팅 api/godiv 확인) → 서버 리로드.
2. 라이브 검증 §3 (옛앱 회귀 0 + entitlements 추가 + 사용기록).
3. (통과 시) 웹스토어 별 게이트로 0.3.1 제출 준비 → 제출 직전 보고.
4. 운영 스크립트 EC2 배치(승격 도구) — 첫 유료 주문 처리 대비.

⛔ 어느 단계도 지디 GO 없이 실행 안 함. main push 안 함(Vercel 자동배포 회피).
