import { query } from '../db/pool.js';
import { sendIssueAlert } from '../alerts/webhook.js';
import { eventIdToUuid, normalizeEvent, type SentryEvent } from './event.js';

export interface Project {
  id: number;
  slug: string;
  name: string;
  public_key: string;
  webhook_url: string | null;
}

export async function storeEvent(project: Project, raw: SentryEvent): Promise<string> {
  const event = normalizeEvent(raw);

  // Atomic regression detection: with concurrent events for the same resolved
  // issue, exactly one of them wins this UPDATE, so the webhook fires once.
  const reopened = await query<{ id: number }>(
    `UPDATE issues SET status = 'unresolved'
     WHERE project_id = $1 AND fingerprint = $2 AND status = 'resolved'
     RETURNING id`,
    [project.id, event.fingerprint],
  );
  const isRegression = (reopened.rowCount ?? 0) > 0;

  const upsert = await query<{ id: number; is_new: boolean }>(
    `INSERT INTO issues (project_id, fingerprint, title, culprit, level, event_count, first_seen, last_seen)
     VALUES ($1, $2, $3, $4, $5, 1, $6, $6)
     ON CONFLICT (project_id, fingerprint) DO UPDATE SET
       event_count = issues.event_count + 1,
       last_seen   = GREATEST(issues.last_seen, EXCLUDED.last_seen),
       title       = EXCLUDED.title,
       culprit     = EXCLUDED.culprit,
       level       = EXCLUDED.level
     RETURNING id, (xmax = 0) AS is_new`,
    [project.id, event.fingerprint, event.title, event.culprit, event.level, event.timestamp],
  );
  const issueId = upsert.rows[0].id;
  const isNew = upsert.rows[0].is_new;

  await query(
    `INSERT INTO events (id, project_id, issue_id, timestamp, level, message, environment, release, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (id) DO NOTHING`,
    [
      eventIdToUuid(event.eventId),
      project.id,
      issueId,
      event.timestamp,
      event.level,
      event.message,
      event.environment,
      event.release,
      JSON.stringify(event.payload),
    ],
  );

  if (isNew || isRegression) {
    // Fire-and-forget: alert failures must never fail ingestion.
    void sendIssueAlert(project, {
      issueId,
      title: event.title,
      culprit: event.culprit,
      level: event.level,
      environment: event.environment,
      kind: isNew ? 'new' : 'regression',
    });
  }

  return event.eventId;
}
