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

// 프로젝트당 분당 받아들이는 바이트 수(압축을 푼 뒤 기준). 이벤트 건수 한도만
// 있으면 건당 최대 크기로 꽉 채워 보내 저장소를 빠르게 불릴 수 있다.
// 기본 100 MB/분. INGEST_BYTES_LIMIT_PER_MIN=0 이면 끈다.
const BYTES_LIMIT_PER_MIN = (() => {
  const raw = Number(process.env.INGEST_BYTES_LIMIT_PER_MIN);
  return Number.isFinite(raw) && raw >= 0 ? raw : 100 * 1024 * 1024;
})();

interface Window {
  start: number;
  count: number;
}

export interface RateResult {
  allowed: boolean;
  retryAfterSec: number;
}

export interface WindowLimiter {
  /** n 만큼 쓰겠다고 기록하고 허용 여부를 돌려준다. 한도를 넘으면 기록하지 않는다. */
  check(key: string | number, n?: number): RateResult;
  /** 기록 없이, 지금 창이 이미 한도에 닿았는지만 본다. */
  exhausted(key: string | number): RateResult;
}

/**
 * 키(프로젝트)별 고정 창(1분) 카운터. limit 이 0 이면 항상 허용.
 * now 는 테스트에서 시계를 바꿔 끼우기 위한 것.
 */
export function createWindowLimiter(
  limit: number,
  now: () => number = Date.now,
): WindowLimiter {
  const windows = new Map<string | number, Window>();
  let lastPrune = 0;

  // 프로젝트가 생겼다 없어져도 맵이 끝없이 자라지 않게, 만료된 창을 가끔 지운다.
  function pruneOccasionally(t: number): void {
    if (t - lastPrune < WINDOW_MS) return;
    lastPrune = t;
    for (const [key, w] of windows) {
      if (t - w.start >= WINDOW_MS) windows.delete(key);
    }
  }

  function current(key: string | number, t: number): Window {
    let w = windows.get(key);
    if (!w || t - w.start >= WINDOW_MS) {
      w = { start: t, count: 0 };
      windows.set(key, w);
      pruneOccasionally(t);
    }
    return w;
  }

  const denied = (w: Window, t: number): RateResult => ({
    allowed: false,
    retryAfterSec: Math.max(1, Math.ceil((w.start + WINDOW_MS - t) / 1000)),
  });
  const ok: RateResult = { allowed: true, retryAfterSec: 0 };

  return {
    check(key, n = 1) {
      if (limit === 0) return ok;
      const t = now();
      const w = current(key, t);
      if (w.count + n > limit) return denied(w, t);
      w.count += n;
      return ok;
    },
    exhausted(key) {
      if (limit === 0) return ok;
      const t = now();
      const w = current(key, t);
      return w.count >= limit ? denied(w, t) : ok;
    },
  };
}

const eventLimiter = createWindowLimiter(LIMIT_PER_MIN);
const byteLimiter = createWindowLimiter(BYTES_LIMIT_PER_MIN);

/**
 * Account `n` events against a project's current window and report whether they
 * are allowed. Disabled (always allowed) when the limit is 0.
 */
export function checkRate(projectId: string | number, n = 1): RateResult {
  return eventLimiter.check(projectId, n);
}

/** 이번 요청의 (풀린) 바이트 수를 프로젝트 창에 기록하고 허용 여부를 돌려준다. */
export function checkByteRate(projectId: string | number, bytes: number): RateResult {
  return byteLimiter.check(projectId, bytes);
}

/** 압축을 풀기 전에 싸게 확인: 이 프로젝트가 이미 바이트 한도를 다 썼는가. */
export function byteRateExhausted(projectId: string | number): RateResult {
  return byteLimiter.exhausted(projectId);
}
