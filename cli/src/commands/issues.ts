import chalk from 'chalk';
import { api, resolveProject, type IssueStatus } from '../api.js';
import { describeIssue, printIssueTable, statusBadge, timeAgo } from '../format.js';

export async function issuesCommand(opts: {
  project?: string;
  status?: string;
  search?: string;
  limit?: string;
  json?: boolean;
}): Promise<void> {
  const project = await resolveProject(opts.project);
  const status = (['unresolved', 'resolved', 'ignored'].includes(opts.status ?? '')
    ? opts.status
    : 'unresolved') as IssueStatus;
  const { issues, counts } = await api.issues(project.id, {
    status,
    q: opts.search,
    limit: opts.limit ? parseInt(opts.limit, 10) : undefined,
  });

  if (opts.json) {
    console.log(JSON.stringify({ project: project.slug, status, issues, counts }, null, 2));
    return;
  }

  console.log(
    chalk.bold(`${project.name}`) +
      chalk.dim(
        ` — ${counts.unresolved ?? 0} unresolved / ${counts.resolved ?? 0} resolved / ${counts.ignored ?? 0} ignored`,
      ),
  );
  console.log(chalk.dim(`showing ${status}${opts.search ? ` matching "${opts.search}"` : ''}:`));
  printIssueTable(issues);
}

export async function issueCommand(id: string, opts: { json?: boolean }): Promise<void> {
  const issue = await api.issue(parseInt(id, 10));
  if (opts.json) {
    console.log(JSON.stringify(issue, null, 2));
    return;
  }
  console.log(describeIssue(issue));
}

export async function eventsCommand(id: string, opts: { limit?: string; json?: boolean }): Promise<void> {
  const { events } = await api.issueEvents(parseInt(id, 10), opts.limit ? parseInt(opts.limit, 10) : 20);
  if (opts.json) {
    console.log(JSON.stringify(events, null, 2));
    return;
  }
  for (const e of events) {
    console.log(
      `  ${chalk.dim(e.timestamp)}  ${e.level.padEnd(8)} ${chalk.dim(e.environment ?? '-')}  ${e.id}`,
    );
  }
  if (events.length === 0) console.log(chalk.gray('  (no events)'));
}

export async function setStatusCommand(ids: string[], status: IssueStatus): Promise<void> {
  for (const id of ids) {
    const issue = await api.updateIssue(parseInt(id, 10), status);
    console.log(
      chalk.green(`✓ #${issue.id}`) +
        ` ${statusBadge(issue.status)} ${chalk.dim(`(${issue.title.slice(0, 80)}, last seen ${timeAgo(issue.last_seen)})`)}`,
    );
  }
}
