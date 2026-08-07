import { gunzipSync, inflateSync } from 'node:zlib';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { query } from '../db/pool.js';
import { parseEnvelope } from '../ingest/envelope.js';
import { storeEvent, type Project } from '../ingest/store.js';
import type { SentryEvent } from '../ingest/event.js';

/**
 * Sentry SDK-facing endpoints. With a DSN of
 *   http://<publicKey>@lookout-host:9000/<projectId>
 * SDKs POST envelopes to /api/<projectId>/envelope/ (and older clients JSON
 * events to /api/<projectId>/store/), authenticated by the DSN public key.
 */

function extractSentryKey(req: FastifyRequest): string | null {
  const header = req.headers['x-sentry-auth'];
  if (typeof header === 'string') {
    const m = header.match(/sentry_key=([a-zA-Z0-9]+)/);
    if (m) return m[1];
  }
  const q = req.query as Record<string, string | undefined>;
  return q.sentry_key ?? null;
}

function decompress(req: FastifyRequest, body: Buffer): Buffer {
  const encoding = req.headers['content-encoding'];
  if (encoding === 'gzip') return gunzipSync(body);
  if (encoding === 'deflate') return inflateSync(body);
  return body;
}

async function authenticateProject(
  req: FastifyRequest,
  projectId: string,
): Promise<Project | null> {
  const key = extractSentryKey(req);
  if (!key || !/^\d+$/.test(projectId)) return null;
  const { rows } = await query<Project>(
    'SELECT id, slug, name, public_key, webhook_url FROM projects WHERE id = $1',
    [parseInt(projectId, 10)],
  );
  if (rows.length === 0 || rows[0].public_key !== key) return null;
  return rows[0];
}

export function registerIngestRoutes(app: FastifyInstance): void {
  // @sentry/node v7 sends envelopes with no Content-Type header at all, and
  // other SDKs use application/x-sentry-envelope; catch everything that isn't
  // JSON as a raw buffer (application/json keeps fastify's built-in parser).
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) =>
    done(null, body),
  );

  app.post('/api/:projectId/envelope/', async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const project = await authenticateProject(req, projectId);
    if (!project) return reply.code(401).send({ error: 'invalid DSN key or project' });

    let envelope;
    try {
      const raw = decompress(req, req.body as Buffer);
      envelope = parseEnvelope(raw);
    } catch {
      return reply.code(400).send({ error: 'malformed envelope' });
    }

    let lastEventId: string | null = null;
    for (const item of envelope.items) {
      if (item.header.type !== 'event') continue; // transactions/sessions/etc: accepted, dropped
      try {
        const event = JSON.parse(item.payload.toString('utf8')) as SentryEvent;
        lastEventId = await storeEvent(project, event);
      } catch (err) {
        req.log.warn({ err }, 'failed to store envelope event');
      }
    }
    return reply.code(200).send({ id: lastEventId ?? envelope.header.event_id ?? null });
  });

  // Legacy store endpoint: a single JSON event as the body.
  app.post('/api/:projectId/store/', async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const project = await authenticateProject(req, projectId);
    if (!project) return reply.code(401).send({ error: 'invalid DSN key or project' });

    try {
      const body = req.body;
      const event = (
        Buffer.isBuffer(body) ? JSON.parse(decompress(req, body).toString('utf8')) : body
      ) as SentryEvent;
      const id = await storeEvent(project, event);
      return reply.code(200).send({ id });
    } catch {
      return reply.code(400).send({ error: 'malformed event' });
    }
  });
}
