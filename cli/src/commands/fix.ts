import { spawn, spawnSync } from 'node:child_process';
import { confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import { api } from '../api.js';
import { buildFixPrompt } from '../format.js';

/**
 * `lookout fix <issue>` — fetch the issue with its latest event, build a
 * repair prompt (stack trace, breadcrumbs, context) and hand it to the
 * `claude` CLI as an interactive session in the current repo. When Claude
 * exits cleanly the issue can be marked resolved (Claude is also told it may
 * run `lookout resolve` itself).
 */
export async function fixCommand(
  id: string,
  opts: { print?: boolean; resolve?: boolean; model?: string },
): Promise<void> {
  const issue = await api.issue(parseInt(id, 10));
  const prompt = buildFixPrompt(issue);

  if (opts.print) {
    console.log(prompt);
    return;
  }

  if (!hasClaude()) {
    console.error(chalk.yellow('`claude` CLI not found on PATH. Printing the prompt instead:\n'));
    console.log(prompt);
    console.error(chalk.dim('\nInstall Claude Code: https://claude.com/claude-code'));
    process.exitCode = 1;
    return;
  }

  console.log(chalk.bold(`Launching Claude Code for issue #${issue.id}: ${issue.title}`));
  console.log(chalk.dim(`  ${issue.event_count} occurrences, last seen ${issue.last_seen}\n`));

  const args = [prompt];
  if (opts.model) args.push('--model', opts.model);
  const code = await run('claude', args);

  if (code !== 0) {
    console.error(chalk.yellow(`\nclaude exited with code ${code}; issue #${issue.id} left as-is.`));
    process.exitCode = code ?? 1;
    return;
  }

  // Claude may have resolved it already (the prompt tells it to).
  const after = await api.issue(issue.id);
  if (after.status === 'resolved') {
    console.log(chalk.green(`\n✓ Issue #${issue.id} is resolved.`));
    return;
  }

  const doResolve =
    opts.resolve ??
    (await confirm({ message: `Mark issue #${issue.id} as resolved?`, default: true }).catch(() => false));
  if (doResolve) {
    await api.updateIssue(issue.id, 'resolved');
    console.log(chalk.green(`✓ Issue #${issue.id} marked resolved.`));
  } else {
    console.log(chalk.dim(`Issue #${issue.id} left ${after.status}.`));
  }
}

function hasClaude(): boolean {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  return spawnSync(probe, ['claude'], { stdio: 'ignore' }).status === 0;
}

function run(cmd: string, args: string[]): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => resolve(code));
  });
}
