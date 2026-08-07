/**
 * lookout-node — tiny zero-dependency client for lookout
 * (https://github.com/datamaker/lookout), a self-hosted Sentry-compatible
 * error tracker. Speaks the Sentry envelope protocol, so it also works
 * against sentry.io and any other Sentry-compatible backend.
 */

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';

const SDK_NAME = '@datasee/lookout';
const SDK_VERSION = '0.1.0';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Level = 'fatal' | 'error' | 'warning' | 'info' | 'debug';

export interface Breadcrumb {
  timestamp?: number;
  category?: string;
  message?: string;
  level?: Level;
  type?: string;
  data?: Record<string, unknown>;
}

export interface User {
  id?: string | number;
  username?: string;
  email?: string;
  ip_address?: string;
  [key: string]: unknown;
}

export interface StackFrame {
  filename?: string;
  function?: string;
  lineno?: number;
  colno?: number;
  in_app?: boolean;
  context_line?: string;
  pre_context?: string[];
  post_context?: string[];
}

export interface LookoutEvent {
  event_id: string;
  timestamp: number;
  platform: 'node';
  level: Level;
  message?: string;
  exception?: { values: { type: string; value: string; stacktrace?: { frames: StackFrame[] } }[] };
  breadcrumbs?: { values: Breadcrumb[] };
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
  user?: User;
  request?: { method?: string; url?: string; headers?: Record<string, string> };
  environment?: string;
  release?: string;
  server_name?: string;
  sdk: { name: string; version: string };
}

export interface CaptureContext {
  level?: Level;
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
  user?: User;
  request?: { method?: string; url?: string; headers?: Record<string, string> };
}

export interface LookoutOptions {
  /** e.g. http://<public-key>@lookout.example.com:9000/1 */
  dsn: string;
  environment?: string;
  release?: string;
  serverName?: string;
  /** Attach process.on('uncaughtException'/'unhandledRejection') handlers. Default true. */
  captureUnhandled?: boolean;
  /** Max stored breadcrumbs. Default 30. */
  maxBreadcrumbs?: number;
  /** Read source files to attach context lines to in-app frames. Default true. */
  attachSourceContext?: boolean;
  /** Return null to drop the event, or mutate/replace it. */
  beforeSend?: (event: LookoutEvent) => LookoutEvent | null;
  /** Log transport errors etc. to the console. Default false. */
  debug?: boolean;
}

// ---------------------------------------------------------------------------
// Client state
// ---------------------------------------------------------------------------

interface Dsn {
  endpoint: string;
  authHeader: string;
}

interface State {
  dsn: Dsn;
  options: Required<Pick<LookoutOptions, 'captureUnhandled' | 'maxBreadcrumbs' | 'attachSourceContext' | 'debug'>> &
    LookoutOptions;
  tags: Record<string, string>;
  extra: Record<string, unknown>;
  user: User | null;
  breadcrumbs: Breadcrumb[];
  inflight: Set<Promise<unknown>>;
  detachHandlers: (() => void) | null;
}

let state: State | null = null;

function parseDsn(dsn: string): Dsn {
  const url = new URL(dsn);
  const key = url.username;
  const projectId = url.pathname.replace(/^\//, '');
  if (!key || !/^\d+$/.test(projectId)) {
    throw new Error(`lookout: invalid DSN "${dsn}" (expected scheme://key@host/projectId)`);
  }
  return {
    endpoint: `${url.protocol}//${url.host}/api/${projectId}/envelope/`,
    authHeader: `Sentry sentry_version=7, sentry_client=${SDK_NAME}/${SDK_VERSION}, sentry_key=${key}`,
  };
}

function debugLog(...args: unknown[]): void {
  if (state?.options.debug) console.warn('[lookout]', ...args);
}

// ---------------------------------------------------------------------------
// Stack traces
// ---------------------------------------------------------------------------

const FRAME_RE = /^\s*at (?:(.+?) \()?(?:(.+?):(\d+):(\d+)|([^)]+))\)?$/;
const CONTEXT_LINES = 5;

function isInApp(filename: string): boolean {
  return (
    !filename.includes('node_modules') &&
    !filename.startsWith('node:') &&
    !filename.startsWith('internal/')
  );
}

function attachContext(frame: StackFrame): void {
  if (!frame.filename || frame.lineno == null || !frame.in_app) return;
  try {
    const lines = readFileSync(frame.filename, 'utf8').split('\n');
    const idx = frame.lineno - 1;
    if (idx < 0 || idx >= lines.length) return;
    const clip = (l: string) => (l.length > 300 ? l.slice(0, 300) : l);
    frame.pre_context = lines.slice(Math.max(0, idx - CONTEXT_LINES), idx).map(clip);
    frame.context_line = clip(lines[idx]);
    frame.post_context = lines.slice(idx + 1, idx + 1 + CONTEXT_LINES).map(clip);
  } catch {
    /* source not readable — fine */
  }
}

export function parseStack(stack: string, withContext: boolean): StackFrame[] {
  const frames: StackFrame[] = [];
  for (const line of stack.split('\n').slice(1)) {
    const m = FRAME_RE.exec(line);
    if (!m) continue;
    const [, fn, file, lineno, colno, bare] = m;
    const filename = file ?? bare;
    if (!filename) continue;
    const frame: StackFrame = {
      function: fn ?? '<anonymous>',
      filename,
      lineno: lineno ? parseInt(lineno, 10) : undefined,
      colno: colno ? parseInt(colno, 10) : undefined,
      in_app: isInApp(filename),
    };
    if (withContext) attachContext(frame);
    frames.push(frame);
  }
  // V8 lists newest frame first; the Sentry protocol wants oldest first.
  return frames.reverse();
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

function send(event: LookoutEvent): void {
  if (!state) return;
  const { dsn } = state;
  const header = JSON.stringify({
    event_id: event.event_id,
    sent_at: new Date().toISOString(),
    sdk: { name: SDK_NAME, version: SDK_VERSION },
  });
  const item = JSON.stringify(event);
  const itemHeader = JSON.stringify({ type: 'event', length: Buffer.byteLength(item, 'utf8') });
  const envelope = `${header}\n${itemHeader}\n${item}`;

  const p = fetch(dsn.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-sentry-envelope',
      'X-Sentry-Auth': dsn.authHeader,
    },
    body: envelope,
    signal: AbortSignal.timeout(10_000),
  })
    .then((res) => {
      if (!res.ok) debugLog(`server responded ${res.status}`);
    })
    .catch((err) => debugLog('send failed:', (err as Error).message));

  state.inflight.add(p);
  void p.finally(() => state?.inflight.delete(p));
}

// ---------------------------------------------------------------------------
// Event building
// ---------------------------------------------------------------------------

function baseEvent(level: Level, ctx?: CaptureContext): LookoutEvent {
  const s = state!;
  return {
    event_id: randomBytes(16).toString('hex'),
    timestamp: Date.now() / 1000,
    platform: 'node',
    level,
    environment: s.options.environment,
    release: s.options.release,
    server_name: s.options.serverName ?? hostname(),
    sdk: { name: SDK_NAME, version: SDK_VERSION },
    breadcrumbs: s.breadcrumbs.length ? { values: [...s.breadcrumbs] } : undefined,
    tags: { ...s.tags, ...ctx?.tags },
    extra: { ...s.extra, ...ctx?.extra },
    user: ctx?.user ?? s.user ?? undefined,
    request: ctx?.request,
  };
}

function dispatch(event: LookoutEvent): string {
  const s = state!;
  let processed: LookoutEvent | null = event;
  if (s.options.beforeSend) {
    try {
      processed = s.options.beforeSend(event);
    } catch (err) {
      debugLog('beforeSend threw:', err);
    }
  }
  if (processed) send(processed);
  return event.event_id;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function init(options: LookoutOptions): void {
  const dsn = parseDsn(options.dsn);
  state = {
    dsn,
    options: {
      captureUnhandled: true,
      maxBreadcrumbs: 30,
      attachSourceContext: true,
      debug: false,
      ...options,
    },
    tags: {},
    extra: {},
    user: null,
    breadcrumbs: [],
    inflight: new Set(),
    detachHandlers: null,
  };

  if (state.options.captureUnhandled) {
    const onUncaught = (err: Error) => {
      captureException(err, { level: 'fatal' });
      console.error(err);
      void flush(2000).then(() => process.exit(1));
    };
    const onRejection = (reason: unknown) => {
      captureException(reason, { level: 'error' });
      debugLog('unhandled rejection captured:', reason);
    };
    process.on('uncaughtException', onUncaught);
    process.on('unhandledRejection', onRejection);
    state.detachHandlers = () => {
      process.off('uncaughtException', onUncaught);
      process.off('unhandledRejection', onRejection);
    };
  }
}

export function captureException(error: unknown, ctx?: CaptureContext): string {
  if (!state) return '';
  const err = error instanceof Error ? error : new Error(typeof error === 'string' ? error : JSON.stringify(error));
  const event = baseEvent(ctx?.level ?? 'error', ctx);
  event.exception = {
    values: [
      {
        type: err.name || 'Error',
        value: err.message,
        stacktrace: err.stack
          ? { frames: parseStack(err.stack, state.options.attachSourceContext) }
          : undefined,
      },
    ],
  };
  return dispatch(event);
}

export function captureMessage(message: string, level: Level = 'info', ctx?: CaptureContext): string {
  if (!state) return '';
  const event = baseEvent(ctx?.level ?? level, ctx);
  event.message = message;
  return dispatch(event);
}

export function addBreadcrumb(crumb: Breadcrumb): void {
  if (!state) return;
  state.breadcrumbs.push({ timestamp: Date.now() / 1000, ...crumb });
  if (state.breadcrumbs.length > state.options.maxBreadcrumbs) {
    state.breadcrumbs.splice(0, state.breadcrumbs.length - state.options.maxBreadcrumbs);
  }
}

export function setTag(key: string, value: string): void {
  if (state) state.tags[key] = value;
}

export function setTags(tags: Record<string, string>): void {
  if (state) Object.assign(state.tags, tags);
}

export function setExtra(key: string, value: unknown): void {
  if (state) state.extra[key] = value;
}

export function setUser(user: User | null): void {
  if (state) state.user = user;
}

/** Wait for queued events to be delivered. Resolves false on timeout. */
export async function flush(timeoutMs = 5000): Promise<boolean> {
  if (!state) return true;
  const pending = Promise.allSettled([...state.inflight]);
  const timer = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), timeoutMs).unref());
  return (await Promise.race([pending, timer])) !== 'timeout';
}

/** Flush, detach global handlers, and disable the client. */
export async function close(timeoutMs = 5000): Promise<boolean> {
  const ok = await flush(timeoutMs);
  state?.detachHandlers?.();
  state = null;
  return ok;
}

/**
 * Express/Connect error-handling middleware:
 *   app.use(lookout.expressErrorHandler());
 */
export function expressErrorHandler() {
  return (err: unknown, req: { method?: string; originalUrl?: string; url?: string }, _res: unknown, next: (e: unknown) => void) => {
    captureException(err, { request: { method: req.method, url: req.originalUrl ?? req.url } });
    next(err);
  };
}
