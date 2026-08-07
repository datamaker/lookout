import { baseUrl } from '../config.js';
import type { Project } from '../ingest/store.js';

export interface IssueAlert {
  issueId: number;
  title: string;
  culprit: string | null;
  level: string;
  environment: string | null;
  kind: 'new' | 'regression';
}

/**
 * Posts a Slack-compatible `{ text }` JSON payload to the project's webhook.
 * Works as-is with Slack incoming webhooks, Discord (/slack suffix), and most
 * generic webhook receivers.
 */
export async function sendIssueAlert(project: Project, alert: IssueAlert): Promise<void> {
  if (!project.webhook_url) return;

  const emoji = alert.kind === 'new' ? '🆕' : '🔁';
  const label = alert.kind === 'new' ? 'New issue' : 'Regression';
  const link = `${baseUrl()}/issues/${alert.issueId}`;
  const lines = [
    `${emoji} *${label}* in *${project.name}* [${alert.level}${alert.environment ? ` · ${alert.environment}` : ''}]`,
    alert.title,
    alert.culprit ? `at ${alert.culprit}` : null,
    link,
  ].filter(Boolean);

  try {
    const res = await fetch(project.webhook_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: lines.join('\n') }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      console.warn(`webhook for project ${project.slug} responded ${res.status}`);
    }
  } catch (err) {
    console.warn(`webhook for project ${project.slug} failed:`, (err as Error).message);
  }
}
