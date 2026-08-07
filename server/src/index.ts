import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { config } from './config.js';
import { migrate } from './db/migrate.js';
import { registerIngestRoutes } from './routes/ingest.js';
import { registerApiRoutes } from './routes/api.js';
import { startRetentionLoop } from './retention.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  await migrate();

  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    bodyLimit: 20 * 1024 * 1024,
  });

  await app.register(cors, { origin: true });

  registerIngestRoutes(app);
  registerApiRoutes(app);

  app.get('/healthz', async () => ({ ok: true }));

  // Serve the built dashboard when present (production image / `npm run build`).
  const webDist = path.resolve(__dirname, '../../web/dist');
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist });
    app.setNotFoundHandler((req, reply) => {
      // SPA fallback for non-API GET routes.
      if (req.method === 'GET' && !req.url.startsWith('/api/')) {
        return reply.sendFile('index.html');
      }
      return reply.code(404).send({ error: 'not found' });
    });
  }

  if (config.adminPassword === 'lookout') {
    app.log.warn(
      'LOOKOUT_ADMIN_PASSWORD is not set — dashboard password is the default "lookout". Set it before exposing this server.',
    );
  }

  startRetentionLoop();

  await app.listen({ port: config.port, host: config.host });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
