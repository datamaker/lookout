import chalk from 'chalk';
import { api, resolveProject } from '../api.js';
import { saveLinkedProject } from '../config.js';

export async function projectsCommand(opts: { json?: boolean }): Promise<void> {
  const projects = await api.projects();
  if (opts.json) {
    console.log(JSON.stringify(projects, null, 2));
    return;
  }
  if (projects.length === 0) {
    console.log(chalk.gray('No projects yet — create one in the lookout web UI.'));
    return;
  }
  for (const p of projects) {
    console.log(
      `  ${chalk.bold(p.slug.padEnd(24))} ${chalk.red(String(p.unresolved_count).padStart(5))} unresolved` +
        `  ${chalk.dim(`${p.events_24h} events/24h`)}  ${chalk.dim(`#${p.id}`)}`,
    );
  }
}

export async function linkCommand(ref: string | undefined, opts: { project?: string }): Promise<void> {
  const project = await resolveProject(ref ?? opts.project);
  const path = saveLinkedProject(project.slug);
  console.log(chalk.green(`✓ Linked this directory to project "${project.slug}" (${path})`));
}
