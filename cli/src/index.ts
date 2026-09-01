#!/usr/bin/env node
import chalk from 'chalk';
import { Command } from 'commander';
import { ApiError } from './api.js';
import { fixCommand } from './commands/fix.js';
import { eventsCommand, issueCommand, issuesCommand, setStatusCommand } from './commands/issues.js';
import { loginCommand, logoutCommand, whoamiCommand } from './commands/login.js';
import { mcpCommand, mcpInstallCommand } from './commands/mcp.js';
import { linkCommand, projectsCommand } from './commands/projects.js';

const program = new Command();

program
  .name('lookout')
  .description('CLI for lookout — self-hosted, Sentry-compatible error tracking')
  .version('0.2.0');

program
  .command('login')
  .description('Log in to a lookout server — SSO device flow when available, else email/password (stores a 7-day token)')
  .option('--url <url>', 'server URL, e.g. https://lookout.example.com')
  .option('--email <email>', 'use password login with this email')
  .option('--password [password]', 'force password login (value optional; omit to be prompted securely)')
  .action(loginCommand);

program.command('logout').description('Forget the stored token').action(logoutCommand);
program.command('whoami').alias('status').description('Show the logged-in user and server').action(whoamiCommand);

program
  .command('projects')
  .description('List projects')
  .option('--json', 'machine-readable output')
  .action(projectsCommand);

program
  .command('link [project]')
  .description('Pin this directory to a project (writes .lookout.json)')
  .option('-p, --project <project>', 'project id, slug, or name')
  .action(linkCommand);

program
  .command('issues')
  .description('List issues (default: unresolved, newest activity first)')
  .option('-p, --project <project>', 'project id, slug, or name')
  .option('-s, --status <status>', 'unresolved | resolved | ignored', 'unresolved')
  .option('-q, --search <query>', 'search in title/culprit')
  .option('-n, --limit <n>', 'max issues to show', '50')
  .option('--json', 'machine-readable output')
  .action(issuesCommand);

program
  .command('issue <id>')
  .description('Show one issue with the latest stack trace')
  .option('--json', 'machine-readable output (includes raw event payload)')
  .action(issueCommand);

program
  .command('events <issueId>')
  .description('List recent events of an issue')
  .option('-n, --limit <n>', 'max events', '20')
  .option('--json', 'machine-readable output')
  .action(eventsCommand);

program
  .command('resolve <ids...>')
  .description('Mark issue(s) as resolved')
  .action((ids: string[]) => setStatusCommand(ids, 'resolved'));

program
  .command('ignore <ids...>')
  .description('Mark issue(s) as ignored')
  .action((ids: string[]) => setStatusCommand(ids, 'ignored'));

program
  .command('unresolve <ids...>')
  .description('Reopen issue(s)')
  .action((ids: string[]) => setStatusCommand(ids, 'unresolved'));

program
  .command('fix <id>')
  .description('Hand an issue to Claude Code to diagnose and fix in the current repo')
  .option('--print', 'print the repair prompt instead of launching claude')
  .option('--resolve', 'mark resolved automatically after claude exits cleanly')
  .option('--model <model>', 'model to pass through to claude')
  .action(fixCommand);

const mcp = program
  .command('mcp')
  .description('Run as an MCP stdio server (for Claude Code and other MCP clients)')
  .action(mcpCommand);
mcp
  .command('install')
  .description('Register with Claude Code: claude mcp add --scope user lookout -- lookout mcp')
  .action(mcpInstallCommand);

program.parseAsync().catch((err: unknown) => {
  if (err instanceof ApiError) {
    console.error(chalk.red(`Error: ${err.message}`));
  } else if (err instanceof Error && err.name === 'ExitPromptError') {
    // Ctrl-C during an inquirer prompt — exit quietly.
  } else {
    console.error(chalk.red(`Unexpected error: ${(err as Error)?.stack ?? String(err)}`));
  }
  process.exitCode = 1;
});
