import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * package.json 에서 버전을 읽는다.
 * 문자열로 박아 두면 릴리스할 때 한쪽만 올리고 어긋난다 — 0.2.1 을 내고도
 * `lookout --version` 이 0.2.0 을 그대로 출력하고 있었다.
 */
function read(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/version.js → ../package.json, 소스 실행(tsx) → ../package.json
  for (const rel of ['../package.json', '../../package.json']) {
    try {
      const pkg = JSON.parse(readFileSync(join(here, rel), 'utf8'));
      if (pkg?.name === '@datasee/lookout-cli' && pkg.version) return pkg.version as string;
    } catch {
      /* 다음 후보 */
    }
  }
  return '0.0.0';
}

export const VERSION = read();
