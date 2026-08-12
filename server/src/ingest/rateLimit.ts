// Lightweight per-project ingest rate limiting.
//
// The ingest endpoints authenticate by DSN public key, which is embedded in
// client apps and is effectively public — so anyone holding a DSN can flood
// events and grow the events table without bound. A fixed-window counter per
// project caps that: past the limit, ingest returns 429 and Sentry SDKs back
// off on their own. In-memory (single-node) by design, matching the rest of
// the server; it degrades to "no limit" only if the process is restarted, not
// to a crash.

const WINDOW_MS = 60_000;

// Events accepted per project per minute. Generous by default (a busy service
// can burst), but bounded. Override with INGEST_RATE_LIMIT_PER_MIN=0 to disable.
const LIMIT_PER_MIN = (() => {
  const raw = Number(process.env.INGEST_RATE_LIMIT_PER_MIN);
  return Number.isFinite(raw) && raw >= 0 ? raw : 6000;
})();

// Most-events a single envelope may carry. One envelope with a million event
// items is abuse, not telemetry.
export const MAX_EVENTS_PER_ENVELOPE = (() => {
  const raw = Number(process.env.INGEST_MAX_EVENTS_PER_ENVELOPE);
  return Number.isFinite(raw) && raw > 0 ? raw : 100;
})();

interface Window {
  start: number;
  count: number;
}

const windows = new Map<string | number, Window>();

export interface RateResult {
  allowed: boolean;
  retryAfterSec: number;
}

/**
 * Account `n` events against a project's current window and report whether they
 * are allowed. Disabled (always allowed) when the limit is 0.
 */
export function checkRate(projectId: string | number, n = 1): RateResult {
  if (LIMIT_PER_MIN === 0) return { allowed: true, retryAfterSec: 0 };

  const now = Date.now();
  let w = windows.get(projectId);
  if (!w || now - w.start >= WINDOW_MS) {
    w = { start: now, count: 0 };
    windows.set(projectId, w);
    pruneOccasionally(now);
  }

  if (w.count + n > LIMIT_PER_MIN) {
    const retryAfterSec = Math.max(1, Math.ceil((w.start + WINDOW_MS - now) / 1000));
    return { allowed: false, retryAfterSec };
  }

  w.count += n;
  return { allowed: true, retryAfterSec: 0 };
}

// Keep the map from growing unbounded as projects come and go: drop windows
// that have fully expired. Cheap and only runs when a new window opens.
let lastPrune = 0;
function pruneOccasionally(now: number): void {
  if (now - lastPrune < WINDOW_MS) return;
  lastPrune = now;
  for (const [key, w] of windows) {
    if (now - w.start >= WINDOW_MS) windows.delete(key);
  }
}
