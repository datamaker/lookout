import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Global config lives at ~/.config/lookout/config.json (mode 0600 — it holds
 * the JWT). A repo can pin its project with a .lookout.json committed or not,
 * found by walking up from cwd. Env vars override both:
 *   LOOKOUT_URL, LOOKOUT_TOKEN, LOOKOUT_PROJECT
 */

export interface GlobalConfig {
  url?: string;
  token?: string;
  email?: string;
}

const CONFIG_DIR = path.join(os.homedir(), '.config', 'lookout');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const PROJECT_FILE = '.lookout.json';

function readGlobal(): GlobalConfig {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')) as GlobalConfig;
  } catch {
    return {};
  }
}

export function saveGlobal(patch: Partial<GlobalConfig>): void {
  const next = { ...readGlobal(), ...patch };
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  try {
    fs.chmodSync(CONFIG_PATH, 0o600);
  } catch {
    // best effort
  }
}

export function clearAuth(): void {
  const cfg = readGlobal();
  delete cfg.token;
  delete cfg.email;
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
}

export function getUrl(): string | undefined {
  return process.env.LOOKOUT_URL || readGlobal().url;
}

export function getToken(): string | undefined {
  return process.env.LOOKOUT_TOKEN || readGlobal().token;
}

export function getEmail(): string | undefined {
  return readGlobal().email;
}

interface ProjectConfig {
  project: string;
}

/** Walk up from cwd looking for .lookout.json. */
export function getLinkedProject(): string | undefined {
  if (process.env.LOOKOUT_PROJECT) return process.env.LOOKOUT_PROJECT;
  let dir = process.cwd();
  for (;;) {
    const p = path.join(dir, PROJECT_FILE);
    if (fs.existsSync(p)) {
      try {
        const cfg = JSON.parse(fs.readFileSync(p, 'utf-8')) as ProjectConfig;
        if (cfg.project) return String(cfg.project);
      } catch {
        return undefined;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export function saveLinkedProject(project: string): string {
  const p = path.join(process.cwd(), PROJECT_FILE);
  fs.writeFileSync(p, JSON.stringify({ project }, null, 2) + '\n');
  return p;
}
