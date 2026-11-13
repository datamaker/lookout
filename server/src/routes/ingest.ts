import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { query } from '../db/pool.js';
import { parseEnvelope } from '../ingest/envelope.js';
import {
  byteRateExhausted,
  checkByteRate,
  checkRate,
  MAX_EVENTS_PER_ENVELOPE,
  type RateResult,
} from '../ingest/rateLimit.js';
import {
  decompressBody,
  jsonBytes,
  limitEventSize,
  MAX_INGEST_BODY_BYTES,
  PayloadTooLargeError,
  UnsupportedEncodingError,
} from '../ingest/limits.js';
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

function rateLimited(reply: FastifyReply, rate: RateResult): FastifyReply {
  return reply
    .code(429)
    .header('Retry-After', String(rate.retryAfterSec))
    .send({ error: 'rate limited' });
}

/**
 * 압축 해제 실패를 SDK 가 이해하는 상태 코드로 바꾼다.
 * 413 은 Sentry SDK 가 "너무 큼 — 재시도하지 않고 버림"으로 처리한다.
 */
function decompressFailure(reply: FastifyReply, err: unknown, fallback: string): FastifyReply {
  if (err instanceof PayloadTooLargeError) {
    return reply.code(413).send({ error: 'payload too large' });
  }
  if (err instanceof UnsupportedEncodingError) {
    return reply.code(415).send({ error: err.message });
  }
  return reply.code(400).send({ error: fallback });
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

  // 수집 라우트만 본문 한도를 따로 둔다 (전역 한도는 app.ts — 대시보드 API 용으로 작다).
  // 한도를 넘는 본문은 Fastify 가 413 으로 끊는다.
  const routeOpts = { bodyLimit: MAX_INGEST_BODY_BYTES };

  app.post('/api/:projectId/envelope/', routeOpts, async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const project = await authenticateProject(req, projectId);
    if (!project) return reply.code(401).send({ error: 'invalid DSN key or project' });

    // 바이트 한도를 이미 다 쓴 프로젝트는 압축을 풀기도 전에 돌려보낸다.
    const exhausted = byteRateExhausted(project.id);
    if (!exhausted.allowed) return rateLimited(reply, exhausted);

    let raw: Buffer;
    try {
      raw = decompressBody(req.headers['content-encoding'], req.body as Buffer);
    } catch (err) {
      return decompressFailure(reply, err, 'malformed envelope');
    }

    const byteRate = checkByteRate(project.id, raw.length);
    if (!byteRate.allowed) return rateLimited(reply, byteRate);

    let envelope;
    try {
      envelope = parseEnvelope(raw);
    } catch {
      return reply.code(400).send({ error: 'malformed envelope' });
    }

    // Cap events per envelope, then rate-limit per project. Ingest authenticates
    // by a DSN key that is effectively public, so without these one client can
    // flood the events table unbounded (DoS). SDKs honor 429 + Retry-After.
    const eventItems = envelope.items.filter((i) => i.header.type === 'event');
    const accepted = eventItems.slice(0, MAX_EVENTS_PER_ENVELOPE);
    if (eventItems.length > accepted.length) {
      req.log.warn(
        { projectId, dropped: eventItems.length - accepted.length },
        'envelope exceeded per-envelope event cap; extra events dropped',
      );
    }

    const rate = checkRate(project.id, accepted.length || 1);
    if (!rate.allowed) return rateLimited(reply, rate);

    let lastEventId: string | null = null;
    let stored = 0;
    let oversized = 0;
    for (const item of accepted) {
      try {
        const parsed = JSON.parse(item.payload.toString('utf8')) as SentryEvent;
        const { event, truncated } = limitEventSize(parsed);
        if (!event) {
          oversized += 1;
          continue;
        }
        if (truncated) req.log.info({ projectId }, 'oversized event truncated before storing');
        lastEventId = await storeEvent(project, event);
        stored += 1;
      } catch (err) {
        req.log.warn({ err }, 'failed to store envelope event');
      }
    }
    if (oversized > 0) {
      req.log.warn({ projectId, oversized }, 'event exceeded size cap even after truncation; dropped');
      // 저장된 게 하나도 없고 전부 크기 때문에 버려졌으면 SDK 에 413 으로 알린다.
      if (stored === 0) return reply.code(413).send({ error: 'event too large' });
    }
    return reply.code(200).send({ id: lastEventId ?? envelope.header.event_id ?? null });
  });

  // Legacy store endpoint: a single JSON event as the body.
  app.post('/api/:projectId/store/', routeOpts, async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const project = await authenticateProject(req, projectId);
    if (!project) return reply.code(401).send({ error: 'invalid DSN key or project' });

    const rate = checkRate(project.id);
    if (!rate.allowed) return rateLimited(reply, rate);
    const exhausted = byteRateExhausted(project.id);
    if (!exhausted.allowed) return rateLimited(reply, exhausted);

    const body = req.body;
    let parsed: SentryEvent;
    let bytes: number;
    if (Buffer.isBuffer(body)) {
      let raw: Buffer;
      try {
        raw = decompressBody(req.headers['content-encoding'], body);
      } catch (err) {
        return decompressFailure(reply, err, 'malformed event');
      }
      bytes = raw.length;
      try {
        parsed = JSON.parse(raw.toString('utf8')) as SentryEvent;
      } catch {
        return reply.code(400).send({ error: 'malformed event' });
      }
    } else {
      // application/json 은 Fastify 가 (bodyLimit 안에서) 이미 파싱했다.
      parsed = body as SentryEvent;
      bytes = Number(req.headers['content-length']) || jsonBytes(body);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return reply.code(400).send({ error: 'malformed event' });
    }

    const byteRate = checkByteRate(project.id, bytes);
    if (!byteRate.allowed) return rateLimited(reply, byteRate);

    const { event } = limitEventSize(parsed);
    if (!event) return reply.code(413).send({ error: 'event too large' });

    try {
      const id = await storeEvent(project, event);
      return reply.code(200).send({ id });
    } catch {
      return reply.code(400).send({ error: 'malformed event' });
    }
  });
}
