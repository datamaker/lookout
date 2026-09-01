import chalk from 'chalk';
import type { IssueDetail, IssueSummary } from './api.js';

/** Sentry protocol v7 shapes we care about for display. */
interface StackFrame {
  filename?: string;
  abs_path?: string;
  module?: string;
  function?: string;
  lineno?: number;
  colno?: number;
  in_app?: boolean;
  context_line?: string;
}

interface SentryPayload {
  exception?: { values?: { type?: string; value?: string; stacktrace?: { frames?: StackFrame[] } }[] };
  breadcrumbs?: { values?: Breadcrumb[] } | Breadcrumb[];
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
  request?: { method?: string; url?: string };
  message?: unknown;
  [key: string]: unknown;
}

interface Breadcrumb {
  timestamp?: number | string;
  category?: string;
  message?: string;
  level?: string;
  type?: string;
  data?: Record<string, unknown>;
}

export function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export function levelColor(level: string): (s: string) => string {
  switch (level) {
    case 'fatal':
      return chalk.bgRed.white;
    case 'error':
      return chalk.red;
    case 'warning':
      return chalk.yellow;
    case 'info':
      return chalk.blue;
    default:
      return chalk.gray;
  }
}

export function statusBadge(status: string): string {
  switch (status) {
    case 'resolved':
      return chalk.green('resolved');
    case 'ignored':
      return chalk.gray('ignored');
    default:
      return chalk.red('unresolved');
  }
}

export function printIssueTable(issues: IssueSummary[]): void {
  if (issues.length === 0) {
    console.log(chalk.gray('  (no issues)'));
    return;
  }
  for (const i of issues) {
    const count = `×${i.event_count}`.padStart(6);
    console.log(
      `  ${chalk.bold(`#${i.id}`.padEnd(7))} ${levelColor(i.level)(i.level.padEnd(8))} ${chalk.dim(
        count,
      )}  ${chalk.dim(timeAgo(i.last_seen).padEnd(9))} ${truncate(i.title, 90)}`,
    );
    if (i.culprit) console.log(chalk.dim(`          └ ${truncate(i.culprit, 100)}`));
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function extractFrames(payload: SentryPayload): { header: string; frames: StackFrame[] }[] {
  const values = payload.exception?.values ?? [];
  return values.map((v) => ({
    header: v.value ? `${v.type ?? 'Error'}: ${v.value}` : (v.type ?? 'Error'),
    frames: v.stacktrace?.frames ?? [],
  }));
}

function frameLoc(f: StackFrame): string {
  const file = f.filename ?? f.abs_path ?? f.module ?? '?';
  const line = f.lineno != null ? `:${f.lineno}${f.colno != null ? `:${f.colno}` : ''}` : '';
  return `${file}${line}`;
}

/** Plain-text stack trace, most recent frame first (Sentry stores deepest last). */
export function stackTraceText(payload: Record<string, unknown>): string {
  const chains = extractFrames(payload as SentryPayload);
  if (chains.length === 0) return '';
  const parts: string[] = [];
  for (const { header, frames } of chains) {
    parts.push(header);
    for (const f of [...frames].reverse()) {
      const app = f.in_app === false ? '' : ' [app]';
      parts.push(`    at ${f.function ?? '?'} (${frameLoc(f)})${app}`);
      if (f.context_line?.trim()) parts.push(`        > ${f.context_line.trim()}`);
    }
  }
  return parts.join('\n');
}

export function breadcrumbsText(payload: Record<string, unknown>, max = 10): string {
  const raw = (payload as SentryPayload).breadcrumbs;
  const crumbs = Array.isArray(raw) ? raw : (raw?.values ?? []);
  if (crumbs.length === 0) return '';
  return crumbs
    .slice(-max)
    .map((c) => {
      const ts =
        typeof c.timestamp === 'number'
          ? new Date(c.timestamp * 1000).toISOString()
          : (c.timestamp ?? '');
      const data = c.data && Object.keys(c.data).length > 0 ? ` ${JSON.stringify(c.data)}` : '';
      return `- ${ts} [${c.category ?? c.type ?? 'default'}] ${c.message ?? ''}${data}`.trimEnd();
    })
    .join('\n');
}

/** Full plain-text description of an issue — shared by `lookout fix` and the MCP server. */
export function describeIssue(issue: IssueDetail): string {
  const lines: string[] = [];
  lines.push(`Issue #${issue.id} — ${issue.title}`);
  lines.push(`Project: ${issue.project_name} (${issue.project_slug})`);
  lines.push(
    `Level: ${issue.level} | Status: ${issue.status} | Occurrences: ${issue.event_count}` +
      ` | First seen: ${issue.first_seen} | Last seen: ${issue.last_seen}`,
  );
  if (issue.culprit) lines.push(`Culprit: ${issue.culprit}`);

  const ev = issue.latest_event;
  if (ev) {
    lines.push('');
    lines.push(
      `Latest event ${ev.id} at ${ev.timestamp}` +
        (ev.environment ? ` | env: ${ev.environment}` : '') +
        (ev.release ? ` | release: ${ev.release}` : ''),
    );
    const payload = ev.payload ?? {};
    const p = payload as SentryPayload;

    const msg = typeof p.message === 'string' ? p.message : undefined;
    if (msg) {
      lines.push('');
      lines.push('Message:');
      lines.push(msg);
    }

    const stack = stackTraceText(payload);
    if (stack) {
      lines.push('');
      lines.push('Stack trace (most recent call first):');
      lines.push(stack);
    }

    if (p.request?.url) {
      lines.push('');
      lines.push(`Request: ${p.request.method ?? 'GET'} ${p.request.url}`);
    }

    if (p.tags && Object.keys(p.tags).length > 0) {
      lines.push('');
      lines.push(`Tags: ${JSON.stringify(p.tags)}`);
    }

    const crumbs = breadcrumbsText(payload);
    if (crumbs) {
      lines.push('');
      lines.push('Breadcrumbs (most recent last):');
      lines.push(crumbs);
    }

    if (p.extra && Object.keys(p.extra).length > 0) {
      lines.push('');
      lines.push(`Extra: ${JSON.stringify(p.extra, null, 2).slice(0, 2000)}`);
    }
  }
  return lines.join('\n');
}

/** The prompt handed to `claude` by `lookout fix`. */
export function buildFixPrompt(issue: IssueDetail): string {
  return [
    `아래는 에러 트래커(lookout)에 기록된 이슈 #${issue.id}의 정보입니다. 이 저장소에서 에러의 근본 원인을 찾아 코드를 수정해 주세요.`,
    '',
    '---',
    describeIssue(issue),
    '---',
    '',
    '작업 순서:',
    '1. 스택트레이스의 [app] 프레임을 중심으로 원인 코드를 찾는다.',
    '2. 근본 원인을 수정한다 (단순히 에러를 삼키는 방어 코드는 지양).',
    '3. 수정 내용과 원인을 요약해서 설명한다.',
    `4. 수정이 끝나면 \`lookout resolve ${issue.id}\` 명령을 실행해 이슈를 resolved로 표시한다 (lookout CLI 설치됨).`,
  ].join('\n');
}
