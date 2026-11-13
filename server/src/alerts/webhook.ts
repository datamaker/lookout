import { baseUrl, config } from '../config.js';
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
 * 슬랙 mrkdwn 에서 의미를 갖는 & < > 를 이스케이프한다.
 * 이벤트 제목 등은 SDK 가 보낸(=외부에서 조작 가능한) 값이라, 그대로 넣으면
 * `<!channel>` 멘션이나 `<https://evil|보안 공지>` 같은 위장 링크를 심을 수 있다.
 * 줄바꿈도 공백으로 접어 알림에 가짜 줄을 끼워 넣지 못하게 한다.
 */
export function escapeSlackText(text: string, maxLength = 500): string {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  const cut = flat.length > maxLength ? flat.slice(0, maxLength - 1) + '…' : flat;
  return cut.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * 알림을 보내도 되는 웹훅 URL 인지.
 * 기본은 `https://hooks.slack.com/…` 만. LOOKOUT_WEBHOOK_ALLOWED_HOSTS 로 다른
 * 호스트(https)를 추가할 수 있고, `*` 면 아무 호스트(http 포함)나 허용한다.
 * 서버가 임의 주소로 POST 하는 것(SSRF)을 막기 위한 것이다.
 */
export function isAllowedWebhookUrl(
  raw: string,
  allowedHosts: readonly string[] = config.webhookAllowedHosts,
): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (allowedHosts.includes('*')) return url.protocol === 'https:' || url.protocol === 'http:';
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  return host === 'hooks.slack.com' || allowedHosts.includes(host);
}

/** 테스트에서 fetch 를 바꿔 끼우기 위한 타입. */
export type WebhookFetch = (
  url: string,
  init: {
    method: 'POST';
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
    redirect: 'manual';
  },
) => Promise<{ ok: boolean; status: number }>;

/** 알림 본문(슬랙 mrkdwn 텍스트)을 만든다. 이벤트·프로젝트에서 온 값은 모두 이스케이프한다. */
export function buildAlertText(project: Pick<Project, 'name'>, alert: IssueAlert): string {
  const emoji = alert.kind === 'new' ? '🆕' : '🔁';
  const label = alert.kind === 'new' ? 'New issue' : 'Regression';
  const link = `${baseUrl()}/issues/${alert.issueId}`;
  const level = escapeSlackText(alert.level, 30);
  const env = alert.environment ? ` · ${escapeSlackText(alert.environment, 60)}` : '';
  return [
    `${emoji} *${label}* in *${escapeSlackText(project.name, 100)}* [${level}${env}]`,
    escapeSlackText(alert.title),
    alert.culprit ? `at ${escapeSlackText(alert.culprit, 300)}` : null,
    link,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Posts a Slack-compatible `{ text }` JSON payload to the project's webhook.
 * 허용된 호스트로만 보내고, 리다이렉트는 따라가지 않는다.
 */
export async function sendIssueAlert(
  project: Project,
  alert: IssueAlert,
  doFetch: WebhookFetch = fetch as unknown as WebhookFetch,
): Promise<void> {
  if (!project.webhook_url) return;
  if (!isAllowedWebhookUrl(project.webhook_url)) {
    console.warn(
      `webhook for project ${project.slug} skipped: host not allowed ` +
        '(only https://hooks.slack.com unless LOOKOUT_WEBHOOK_ALLOWED_HOSTS is set)',
    );
    return;
  }

  try {
    const res = await doFetch(project.webhook_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: buildAlertText(project, alert) }),
      signal: AbortSignal.timeout(5000),
      // 리다이렉트를 따라가면 허용 호스트 검사를 우회해 내부 주소로 보내질 수 있다.
      redirect: 'manual',
    });
    if (!res.ok) {
      console.warn(`webhook for project ${project.slug} responded ${res.status}`);
    }
  } catch (err) {
    console.warn(`webhook for project ${project.slug} failed:`, (err as Error).message);
  }
}
