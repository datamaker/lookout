import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { migrate } from './db/migrate.js';
import { initAuth } from './auth/service.js';
import { initOidc } from './auth/oidc.js';
import { buildApp } from './app.js';
import { startRetentionLoop } from './retention.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  await migrate();
  await initAuth();
  await initOidc();

  const app = await buildApp({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    webDist: path.resolve(__dirname, '../../web/dist'),
  });

  startRetentionLoop();

  await app.listen({ port: config.port, host: config.host });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
