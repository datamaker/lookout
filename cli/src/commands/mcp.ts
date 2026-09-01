import { spawnSync } from 'node:child_process';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { api, resolveProject, type IssueStatus } from '../api.js';
import { describeIssue } from '../format.js';

/**
 * `lookout mcp` — expose lookout as an MCP stdio server so Claude Code (or
 * any MCP client) can browse projects, read issues with full stack traces,
 * and triage them. Register with:
 *   claude mcp add --scope user lookout -- lookout mcp
 */

function text(data: unknown): { content: { type: 'text'; text: string }[] } {
  return {
    content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }],
  };
}

export async function mcpCommand(): Promise<void> {
  const server = new McpServer({ name: 'lookout', version: '0.2.0' });

  server.tool(
    'list_projects',
    'List all lookout projects with unresolved issue counts and 24h event volume.',
    {},
    async () => text(await api.projects()),
  );

  server.tool(
    'list_issues',
    'List issues in a lookout project. Returns id, title, culprit, level, occurrence count and timestamps.',
    {
      project: z
        .string()
        .optional()
        .describe('Project id, slug, or name. Omit to use the repo-linked or only project.'),
      status: z.enum(['unresolved', 'resolved', 'ignored']).optional().describe('Default: unresolved'),
      query: z.string().optional().describe('Search in title/culprit'),
      limit: z.number().int().min(1).max(200).optional(),
    },
    async ({ project, status, query, limit }) => {
      const p = await resolveProject(project);
      const res = await api.issues(p.id, { status: status as IssueStatus, q: query, limit });
      return text({ project: p.slug, ...res });
    },
  );

  server.tool(
    'get_issue',
    'Get full details of a lookout issue: metadata plus the latest event with stack trace, breadcrumbs, tags and request context, formatted as text.',
    { issue_id: z.number().int().describe('Issue id (the number shown by list_issues)') },
    async ({ issue_id }) => text(describeIssue(await api.issue(issue_id))),
  );

  server.tool(
    'list_events',
    'List recent events (individual occurrences) of a lookout issue.',
    {
      issue_id: z.number().int(),
      limit: z.number().int().min(1).max(200).optional(),
    },
    async ({ issue_id, limit }) => text((await api.issueEvents(issue_id, limit ?? 20)).events),
  );

  server.tool(
    'get_event',
    'Get the raw Sentry-format payload of a single event by event id (UUID from list_events).',
    { event_id: z.string() },
    async ({ event_id }) => text(await api.event(event_id)),
  );

  server.tool(
    'update_issue_status',
    'Set a lookout issue status. Use "resolved" after the underlying bug has been fixed, "ignored" to mute noise, "unresolved" to reopen.',
    {
      issue_id: z.number().int(),
      status: z.enum(['unresolved', 'resolved', 'ignored']),
    },
    async ({ issue_id, status }) => text(await api.updateIssue(issue_id, status as IssueStatus)),
  );

  await server.connect(new StdioServerTransport());
  // Keep quiet on stdout — it belongs to the MCP transport.
  console.error('lookout MCP server ready (stdio)');
}

/** `lookout mcp install` — register this CLI with Claude Code. */
export function mcpInstallCommand(): void {
  const res = spawnSync('claude', ['mcp', 'add', '--scope', 'user', 'lookout', '--', 'lookout', 'mcp'], {
    stdio: 'inherit',
  });
  if (res.error || res.status !== 0) {
    console.error('\nCould not run `claude mcp add`. Register manually:');
    console.error('  claude mcp add --scope user lookout -- lookout mcp');
    process.exitCode = 1;
  }
}
