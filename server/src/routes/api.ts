import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { baseUrl } from '../config.js';
import { query } from '../db/pool.js';
import { requireAdmin, requireUser } from './auth.js';

/**
 * Dashboard API. All routes require a logged-in user (JWT Bearer token from
 * /api/auth/login); project create/update/delete additionally require the
 * admin role. Issue triage (resolve/ignore) is open to members.
 */

function dsnFor(projectId: number, publicKey: string): string {
  const url = new URL(baseUrl());
  return `${url.protocol}//${publicKey}@${url.host}/${projectId}`;
}

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || `project-${Date.now()}`;
}

export function registerApiRoutes(app: FastifyInstance): void {
  app.addHook('preHandler', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    // Auth and user-management routes handle authorization themselves.
    if (req.url.startsWith('/api/auth/') || req.url.startsWith('/api/users')) return;
    // Ingest endpoints authenticate with the DSN key instead.
    if (/^\/api\/\d+\/(envelope|store)\//.test(req.url)) return;
    if (!(await requireUser(req, reply))) return reply;
  });

  app.get('/api/projects', async () => {
    const { rows } = await query(
      `SELECT p.id, p.slug, p.name, p.public_key, p.webhook_url, p.created_at,
              COUNT(i.id) FILTER (WHERE i.status = 'unresolved') AS unresolved_count,
              (SELECT COUNT(*) FROM events e
                WHERE e.project_id = p.id AND e.timestamp > now() - interval '24 hours') AS events_24h
       FROM projects p
       LEFT JOIN issues i ON i.project_id = p.id
       GROUP BY p.id
       ORDER BY p.created_at`,
    );
    return rows.map((p) => ({ ...p, dsn: dsnFor(p.id as number, p.public_key as string) }));
  });

  app.post('/api/projects', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    const { name } = (req.body ?? {}) as { name?: string };
    if (!name?.trim()) return reply.code(400).send({ error: 'name is required' });
    const publicKey = randomUUID().replace(/-/g, '');
    const { rows } = await query(
      `INSERT INTO projects (slug, name, public_key) VALUES ($1, $2, $3) RETURNING *`,
      [slugify(name), name.trim(), publicKey],
    );
    const p = rows[0];
    return reply.code(201).send({ ...p, dsn: dsnFor(p.id, p.public_key) });
  });

  app.patch('/api/projects/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    const id = parseInt((req.params as { id: string }).id, 10);
    const { name, webhookUrl } = (req.body ?? {}) as { name?: string; webhookUrl?: string | null };
    const { rows } = await query(
      `UPDATE projects SET
         name = COALESCE($2, name),
         webhook_url = CASE WHEN $3::boolean THEN $4 ELSE webhook_url END
       WHERE id = $1 RETURNING *`,
      [id, name?.trim() || null, webhookUrl !== undefined, webhookUrl || null],
    );
    if (rows.length === 0) return reply.code(404).send({ error: 'not found' });
    const p = rows[0];
    return { ...p, dsn: dsnFor(p.id, p.public_key) };
  });

  app.delete('/api/projects/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    const id = parseInt((req.params as { id: string }).id, 10);
    await query('DELETE FROM projects WHERE id = $1', [id]);
    return reply.code(204).send();
  });

  app.get('/api/projects/:id/issues', async (req) => {
    const id = parseInt((req.params as { id: string }).id, 10);
    const q = req.query as { status?: string; q?: string; limit?: string; offset?: string };
    const status = ['unresolved', 'resolved', 'ignored'].includes(q.status ?? '')
      ? q.status!
      : 'unresolved';
    const limit = Math.min(parseInt(q.limit ?? '50', 10) || 50, 200);
    const offset = parseInt(q.offset ?? '0', 10) || 0;

    const params: unknown[] = [id, status];
    let where = 'project_id = $1 AND status = $2';
    if (q.q?.trim()) {
      params.push(`%${q.q.trim()}%`);
      where += ` AND (title ILIKE $${params.length} OR culprit ILIKE $${params.length})`;
    }
    params.push(limit, offset);
    const { rows } = await query(
      `SELECT id, title, culprit, level, status, event_count, first_seen, last_seen
       FROM issues WHERE ${where}
       ORDER BY last_seen DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    const counts = await query(
      `SELECT status, COUNT(*)::int AS count FROM issues WHERE project_id = $1 GROUP BY status`,
      [id],
    );
    return { issues: rows, counts: Object.fromEntries(counts.rows.map((r) => [r.status, r.count])) };
  });

  app.get('/api/projects/:id/stats', async (req) => {
    const id = parseInt((req.params as { id: string }).id, 10);
    const hours = Math.min(parseInt((req.query as { hours?: string }).hours ?? '24', 10) || 24, 168);
    const { rows } = await query(
      `SELECT date_trunc('hour', timestamp) AS bucket, COUNT(*)::int AS count
       FROM events
       WHERE project_id = $1 AND timestamp > now() - ($2 || ' hours')::interval
       GROUP BY bucket ORDER BY bucket`,
      [id, String(hours)],
    );
    return { hours, buckets: rows };
  });

  app.get('/api/issues/:id', async (req, reply) => {
    const id = parseInt((req.params as { id: string }).id, 10);
    const { rows } = await query(
      `SELECT i.*, p.name AS project_name, p.slug AS project_slug
       FROM issues i JOIN projects p ON p.id = i.project_id WHERE i.id = $1`,
      [id],
    );
    if (rows.length === 0) return reply.code(404).send({ error: 'not found' });
    const latest = await query(
      `SELECT id, timestamp, level, environment, release, payload
       FROM events WHERE issue_id = $1 ORDER BY timestamp DESC LIMIT 1`,
      [id],
    );
    return { ...rows[0], latest_event: latest.rows[0] ?? null };
  });

  app.get('/api/issues/:id/events', async (req) => {
    const id = parseInt((req.params as { id: string }).id, 10);
    const q = req.query as { limit?: string; offset?: string };
    const limit = Math.min(parseInt(q.limit ?? '50', 10) || 50, 200);
    const offset = parseInt(q.offset ?? '0', 10) || 0;
    const { rows } = await query(
      `SELECT id, timestamp, level, message, environment, release
       FROM events WHERE issue_id = $1 ORDER BY timestamp DESC LIMIT $2 OFFSET $3`,
      [id, limit, offset],
    );
    return { events: rows };
  });

  app.get('/api/events/:id', async (req, reply) => {
    const { rows } = await query('SELECT * FROM events WHERE id = $1', [
      (req.params as { id: string }).id,
    ]);
    if (rows.length === 0) return reply.code(404).send({ error: 'not found' });
    return rows[0];
  });

  app.patch('/api/issues/:id', async (req, reply) => {
    const id = parseInt((req.params as { id: string }).id, 10);
    const { status } = (req.body ?? {}) as { status?: string };
    if (!['unresolved', 'resolved', 'ignored'].includes(status ?? '')) {
      return reply.code(400).send({ error: 'status must be unresolved|resolved|ignored' });
    }
    const { rows } = await query('UPDATE issues SET status = $2 WHERE id = $1 RETURNING *', [
      id,
      status,
    ]);
    if (rows.length === 0) return reply.code(404).send({ error: 'not found' });
    return rows[0];
  });
}
