import type { FastifyInstance } from 'fastify';
import { requireUser } from '../routes/auth.js';

/**
 * 인증 게이트.
 *
 * 예전에는 원본 URL(req.url)이 "/api/" 로 시작하는지로 인증 여부를 정했다.
 * 그런데 라우터는 경로를 퍼센트 디코딩한 뒤 매칭하므로 "/%61pi/projects" 가
 * 인증 없이 "/api/projects" 핸들러까지 들어갔다.
 *
 * 그래서 이제는 "라우터가 실제로 매칭한 라우트 패턴"(req.routeOptions.url)만 보고,
 * 아래 공개 목록에 없는 라우트는 전부 로그인(JWT)을 요구한다 (기본 거부).
 * 새 라우트를 추가하면 자동으로 보호되고, 공개하려면 여기에 명시해야 한다.
 */

/** 로그인 없이 열려 있는 라우트. "메서드 라우트패턴" 형식 (HEAD 는 GET 으로 본다). */
export const PUBLIC_ROUTES: ReadonlySet<string> = new Set([
  // 헬스체크 (Dockerfile HEALTHCHECK, 사내 공통 규약)
  'GET /healthz',

  // SDK 수집 — 핸들러 안에서 DSN 공개 키로 인증한다.
  'POST /api/:projectId/envelope/',
  'POST /api/:projectId/store/',

  // 로그인 전에 불려야 하는 인증 라우트
  'GET /api/auth/status', // 최초 설정이 필요한지
  'POST /api/auth/setup', // 최초 관리자 생성 (사용자가 0명일 때만 동작)
  'POST /api/auth/login',
  'GET /api/auth/oidc/status', // SSO 설정 여부 (로그인 페이지, CLI)
  'POST /api/auth/oidc/exchange', // CLI SSO: IdP id_token 을 검증하고 토큰 발급
  'GET /api/auth/oidc/start',
  'GET /api/auth/oidc/callback',

  // 대시보드 정적 파일 (@fastify/static 와일드카드 라우트)
  'GET /*',
]);

/**
 * 원본 URL 이 API 경로를 가리키는지. 쿼리를 떼고 퍼센트 디코딩한 뒤 판단한다.
 * 디코딩이 안 되는 경로는 안전한 쪽(API 취급 → SPA 폴백 안 함)으로 본다.
 */
export function isApiPath(rawUrl: string): boolean {
  const rawPath = rawUrl.split('?')[0];
  let path: string;
  try {
    path = decodeURIComponent(rawPath);
  } catch {
    return true;
  }
  path = path.toLowerCase().replace(/\/+/g, '/');
  return path === '/api' || path.startsWith('/api/');
}

export function registerAuthGate(app: FastifyInstance): void {
  // onRequest 에서 막는다 — 인증 안 된 요청은 본문(최대 20MB)을 파싱하기도 전에 끊는다.
  app.addHook('onRequest', async (req, reply) => {
    // 매칭된 라우트가 없으면 404 핸들러(정적 파일 / SPA 폴백)로만 간다. API 핸들러에는 닿지 않는다.
    if (req.is404) return;

    const pattern = req.routeOptions.url;
    const method = req.method === 'HEAD' ? 'GET' : req.method;
    if (pattern && PUBLIC_ROUTES.has(`${method} ${pattern}`)) return;

    if (!(await requireUser(req, reply))) return reply;
  });
}
