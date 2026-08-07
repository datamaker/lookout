# HANDOFF

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
