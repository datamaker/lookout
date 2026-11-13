import { existsSync } from 'node:fs';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { registerIngestRoutes } from './routes/ingest.js';
import { registerApiRoutes } from './routes/api.js';
import { registerAuthRoutes, registerUserRoutes } from './routes/auth.js';
import { config } from './config.js';
import { isApiPath, registerAuthGate } from './auth/gate.js';

export interface BuildAppOptions {
  logger?: FastifyServerOptions['logger'];
  /** 빌드된 대시보드(web/dist) 경로. 없거나 디렉터리가 없으면 정적 서빙을 건너뛴다. */
  webDist?: string;
}

/**
 * Fastify 앱을 조립한다. listen 은 하지 않는다 — index.ts 가 띄우고,
 * 테스트는 app.inject 로 같은 앱을 그대로 두드린다.
 * (DB 마이그레이션과 initAuth 는 호출하는 쪽이 먼저 끝내 둔다.)
 */
export async function buildApp(opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? false,
    // 전역 본문 한도는 대시보드 API(작은 JSON) 기준. 수집 라우트는 routes/ingest.ts 에서
    // 따로 정한다(INGEST_MAX_BODY_BYTES). 예전에는 전체가 20 MB 였다.
    bodyLimit: 1024 * 1024,
    // 프록시(nginx) 뒤에서 실제 클라이언트 IP 를 얻기 위한 설정. 로그인 시도 제한이
    // IP 별로 동작하려면 필요하다. 프록시가 없으면 비워 둔다(X-Forwarded-For 를 믿지 않음).
    trustProxy: config.trustProxy,
    // 기본값(true)이면 라우터가 경로를 ';' 에서 잘라 버린다.
    // "/api/projects;x/../../healthz" 같은 요청이 "/api/projects" 로 매칭되는 걸 막는다.
    useSemicolonDelimiter: false,
  });

  await app.register(cors, { origin: true });
  await app.register(cookie);

  // 인증 게이트는 라우트 등록보다 먼저 건다. 이후 등록되는 모든 라우트
  // (플러그인 안쪽 포함)가 이 훅을 물려받는다.
  registerAuthGate(app);

  registerIngestRoutes(app);
  registerAuthRoutes(app);
  registerUserRoutes(app);
  registerApiRoutes(app);

  app.get('/healthz', async () => ({ ok: true }));

  // 빌드된 대시보드가 있으면 같이 서빙한다 (운영 이미지 / `npm run build`).
  if (opts.webDist && existsSync(opts.webDist)) {
    await app.register(fastifyStatic, { root: opts.webDist });
    app.setNotFoundHandler((req, reply) => {
      // SPA 폴백은 API 가 아닌 GET 에만. 원본 URL 이 아니라 디코딩한 경로로 판단한다 —
      // "/%61pi/..." 나 "/api%2F..." 가 200 + index.html 로 떨어지면 안 된다.
      if (req.method === 'GET' && !isApiPath(req.url)) {
        return reply.sendFile('index.html');
      }
      return reply.code(404).send({ error: 'not found' });
    });
  }

  return app;
}
