# HANDOFF

## 상태 v0.2.1 (2026-08-11) — 모바일 대응

대시보드를 폰에서 쓸 수 있게 정리했다. 서버/API/DB 변경 없음, `web/`만 손댔다.

- **가로 스크롤 제거**: 멤버 페이지가 390px 화면에서 816px까지 삐져나갔다(입력 4개 한 줄 + 행당 버튼 4개). 폰 폭(≤640px)에서는 툴바/폼을 세로 스택, 행은 wrap 시켜 한 줄에 하나씩.
- **iOS 입력 확대 방지**: input font-size가 16px 미만이면 사파리가 포커스할 때 페이지를 확대한다(그리고 되돌려주지 않는다). 터치 기기에서 16px로 올렸다.
- **탭 타깃 40px**: 기존 버튼 31px, 상단바/브레드크럼 링크 21px이라 누르기 어려웠다. 폭이 아니라 **입력장치** 기준(`(hover: none) and (pointer: coarse)`)이라 가로모드(667~932px)와 태블릿에서도 적용된다.
- **안전영역/상단바**: `viewport-fit=cover` + `env(safe-area-inset-*)`로 노치·홈바 회피, 상단바는 sticky. 긴 표시 이름은 상단바에서 유일한 shrink 대상이라 말줄임되고 "Log out"은 밀리지 않는다.
- **검증**: Playwright로 프로덕션 빌드를 375/390(세로), 667/844(가로), 768(태블릿)에서 촬영 — 가로 스크롤 0, 16px 미만 입력 0, 36px 미만 탭 타깃 0. 데스크톱 1280px는 7개 중 5개 페이지가 픽셀 동일, 나머지 2개도 서브픽셀 안티에일리어싱 차이뿐이다.

## 상태 v0.2 (2026-08-07 오후)

멤버관리 추가 완료 + 배포 준비:

- **인증 개편**: 어드민 비밀번호 → users 테이블(bcrypt 12r) + 7일 JWT. JWT 시크릿은 미설정 시 자동생성해 settings 테이블에 영속. 첫 방문 시 `/setup`에서 어드민 계정 생성.
- **역할**: admin(프로젝트/웹훅/멤버 관리), member(이슈 조회·트리아지). 12개 권한 시나리오 API 검증 + 브라우저 UI 검증 완료. 자기 강등/비활성화 차단.
- **@sentry/node v10 호환 확인**: bioweekly-backend가 쓰는 v10.55.0으로 withScope+setExtra+captureException 패턴 검증 — extra/stacktrace 정상 수집.
- **배포 준비**: docker-compose.hub.yml + scripts/docker-build-push.sh (datamaker/lookout, linux/amd64). 대상 서버는 cacheby-app EC2(i-02a25fbfe333be1f8, SSM 접속) — /opt/<서비스> 컨벤션, 포트 9000 비어 있음. bioweekly-backend는 같은 VPC private 서브넷 Lambda라 private IP로 도달 가능(SG 9000 인바운드 필요).

## 상태 v0.1 (2026-08-07 오전)

v0.1 동작 확인 완료. `@sentry/node@7.66.0`으로 실제 이벤트를 보내 end-to-end 검증했다:

- envelope 인제스트 → 이슈 그루핑(같은 예외 4건 → 이슈 1개) ✅
- captureMessage / captureException 분리 그루핑 ✅
- resolved 이슈에 재발 이벤트 → 자동 reopen + 웹훅(regression) 발송 ✅
- 대시보드: 로그인, 프로젝트 목록, 이슈 목록(탭/검색/24h 차트), 이슈 상세(스택트레이스+소스 컨텍스트, Context, Breadcrumbs), 설정(DSN 복사, 웹훅) ✅

## 아키텍처 요약

- `server/` — Fastify + pg. 인제스트(`/api/:id/envelope/`, `/api/:id/store/`)는 DSN public key로 인증, 대시보드 API는 어드민 비밀번호에서 파생한 HMAC Bearer 토큰.
- `web/` — React + Vite SPA. 빌드 결과(`web/dist`)를 서버가 정적 서빙.
- 그루핑: sha256(예외타입 + in-app 프레임들의 module:function, 라인번호 제외) → `issues.fingerprint` UNIQUE upsert.
- 보존: `LOOKOUT_RETENTION_DAYS`(기본 90일) 지나면 events만 시간별 삭제, issues는 유지.

## 겪은 함정 (재발 주의)

1. **@sentry/node v7은 envelope을 Content-Type 헤더 없이 보낸다.** Fastify 기본 설정은 415로 거부 → `addContentTypeParser('*', buffer)` 캐치올로 해결 (`server/src/routes/ingest.ts`).
2. CSS `.empty`(빈 상태, padding 48px)가 차트의 `.bar.empty`와 충돌해 차트가 깨졌다 → 차트 쪽은 `.bar.zero`로 개명.
3. 같은 이슈의 이벤트 2건이 동시에 도착하면 regression 웹훅이 중복 발송될 수 있다(status SELECT 후 upsert 사이 레이스). v1에서는 허용; 고치려면 upsert를 CTE로 합치거나 advisory lock.
4. **Playwright/Chromium 모바일 에뮬레이션은 컨텍스트의 두 번째 내비게이션부터 터치 에뮬레이션을 잃는다** — `(pointer: coarse)`가 조용히 false가 되어 터치용 CSS가 통째로 안 먹은 것처럼 보인다. 모바일 레이아웃을 검증할 땐 페이지마다 컨텍스트를 새로 만들고, 측정할 때 `matchMedia(...).matches`를 같이 찍어 두는 게 안전하다.

## 다음 후보

- 이벤트 상세 페이지(이벤트 간 이동), 이슈 병합/삭제
- 알림 rate-limit (같은 이슈 반복 regression 시 쿨다운)
- Docker Hub 이미지 배포 + GitHub Actions
- 429 rate-limit 응답 (X-Sentry-Rate-Limits) — 지금은 무제한 수용

## 개발 명령

```bash
docker compose -f docker-compose.dev.yml up -d   # postgres :5434
npm run dev        # 서버 :9000 (부팅 시 마이그레이션)
npm run dev:web    # Vite :5180
```
