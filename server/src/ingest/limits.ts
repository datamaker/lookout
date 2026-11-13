// 수집(ingest) 크기 한도.
//
// 수집 엔드포인트는 사실상 공개된 DSN 키로 인증한다. 한도가 없으면 몇 KB 짜리
// 압축 폭탄 하나로 프로세스 메모리를 터뜨리거나, 수십 MB 짜리 이벤트로 events
// 테이블을 부풀릴 수 있다. 여기서 "풀린 뒤 크기"와 "이벤트 한 건 크기"를 묶는다.

import {
  brotliDecompressSync,
  gunzipSync,
  inflateSync,
  zstdDecompressSync,
} from 'node:zlib';
import type { SentryEvent } from './event.js';

function envBytes(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

/** 압축을 푼 뒤 본문 최대 크기 (envelope 전체). 기본 2 MB. */
export const MAX_DECOMPRESSED_BYTES = envBytes('INGEST_MAX_DECOMPRESSED_BYTES', 2 * 1024 * 1024);

/** 수집 라우트의 HTTP 본문(압축된 그대로) 최대 크기. 기본값은 풀린 뒤 한도와 같다. */
export const MAX_INGEST_BODY_BYTES = Math.min(
  envBytes('INGEST_MAX_BODY_BYTES', MAX_DECOMPRESSED_BYTES),
  MAX_DECOMPRESSED_BYTES,
);

/** 저장되는 이벤트 한 건(JSON 직렬화 기준)의 최대 크기. 기본 1 MB. */
export const MAX_EVENT_BYTES = envBytes('INGEST_MAX_EVENT_BYTES', 1024 * 1024);

/** 풀린 크기가 한도를 넘었을 때 던진다. 라우트가 413 으로 바꾼다. */
export class PayloadTooLargeError extends Error {
  constructor(message = 'payload too large') {
    super(message);
    this.name = 'PayloadTooLargeError';
  }
}

/** 지원하지 않는 Content-Encoding. 라우트가 415 로 바꾼다. */
export class UnsupportedEncodingError extends Error {
  constructor(encoding: string) {
    super(`unsupported content-encoding: ${encoding}`);
    this.name = 'UnsupportedEncodingError';
  }
}

/**
 * Content-Encoding 에 맞춰 본문을 푼다. 풀린 크기가 maxBytes 를 넘으면 zlib 이
 * 그 지점에서 멈추므로(maxOutputLength) 메모리는 한도까지만 쓴다.
 */
export function decompressBody(
  encodingHeader: string | string[] | undefined,
  body: Buffer,
  maxBytes: number = MAX_DECOMPRESSED_BYTES,
): Buffer {
  const encoding = (Array.isArray(encodingHeader) ? encodingHeader[0] : encodingHeader ?? '')
    .trim()
    .toLowerCase();
  const opts = { maxOutputLength: maxBytes };
  try {
    switch (encoding) {
      case '':
      case 'identity':
        if (body.length > maxBytes) throw new PayloadTooLargeError();
        return body;
      case 'gzip':
      case 'x-gzip':
        return gunzipSync(body, opts);
      case 'deflate':
        return inflateSync(body, opts);
      case 'br':
        return brotliDecompressSync(body, opts);
      case 'zstd':
        return zstdDecompressSync(body, opts);
      default:
        throw new UnsupportedEncodingError(encoding);
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ERR_BUFFER_TOO_LARGE' || code === 'ERR_OUT_OF_RANGE') {
      throw new PayloadTooLargeError('decompressed payload too large');
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// 이벤트 한 건 크기 제한
// ---------------------------------------------------------------------------

const MAX_STRING_CHARS = 8192;
const MAX_ARRAY_ITEMS = 250;
const MAX_OBJECT_KEYS = 250;
const MAX_DEPTH = 24;
const MAX_BREADCRUMBS = 100;
const TRUNCATED = '…[truncated]';

export function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
}

/** 긴 문자열·긴 배열·깊은 중첩을 잘라낸 사본을 만든다. 스택 프레임은 뒤쪽(가장 최근)을 남긴다. */
function clamp(value: unknown, depth: number, keepTail: boolean): unknown {
  if (typeof value === 'string') {
    return value.length > MAX_STRING_CHARS ? value.slice(0, MAX_STRING_CHARS) + TRUNCATED : value;
  }
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return TRUNCATED;
  if (Array.isArray(value)) {
    const items =
      value.length > MAX_ARRAY_ITEMS
        ? keepTail
          ? value.slice(-MAX_ARRAY_ITEMS)
          : value.slice(0, MAX_ARRAY_ITEMS)
        : value;
    return items.map((v) => clamp(v, depth + 1, false));
  }
  const out: Record<string, unknown> = {};
  let n = 0;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (++n > MAX_OBJECT_KEYS) break;
    // frames / values(breadcrumbs) 는 Sentry 규약상 마지막이 가장 최근이다.
    out[k] = clamp(v, depth + 1, k === 'frames' || k === 'values' || k === 'breadcrumbs');
  }
  return out;
}

function trimBreadcrumbs(event: Record<string, unknown>, max: number): void {
  const b = event.breadcrumbs;
  if (Array.isArray(b)) {
    event.breadcrumbs = max === 0 ? [] : b.slice(-max);
  } else if (b && typeof b === 'object' && Array.isArray((b as { values?: unknown }).values)) {
    const values = (b as { values: unknown[] }).values;
    event.breadcrumbs = { ...(b as object), values: max === 0 ? [] : values.slice(-max) };
  }
}

/** 스택 프레임에서 부피가 큰 부가 정보(지역 변수, 앞뒤 소스 줄)를 뗀다. */
function stripFrameExtras(event: Record<string, unknown>): void {
  const strip = (stacktrace: unknown): void => {
    const frames = (stacktrace as { frames?: unknown } | undefined)?.frames;
    if (!Array.isArray(frames)) return;
    for (const f of frames) {
      if (f && typeof f === 'object') {
        delete (f as Record<string, unknown>).vars;
        delete (f as Record<string, unknown>).pre_context;
        delete (f as Record<string, unknown>).post_context;
      }
    }
  };
  const exc = (event.exception as { values?: unknown } | undefined)?.values;
  if (Array.isArray(exc)) for (const v of exc) strip((v as { stacktrace?: unknown })?.stacktrace);
  const threads = (event.threads as { values?: unknown } | undefined)?.values;
  if (Array.isArray(threads)) for (const t of threads) strip((t as { stacktrace?: unknown })?.stacktrace);
  strip(event.stacktrace);
}

export interface LimitedEvent {
  /** 저장할 이벤트. 한도 안으로 줄일 수 없으면 null (거절). */
  event: SentryEvent | null;
  truncated: boolean;
}

/**
 * 이벤트 한 건을 maxBytes 안으로 맞춘다.
 *
 * 한도 안이면 그대로 돌려준다. 넘으면 그룹핑·제목에 쓰이지 않는 부가 정보부터
 * 단계적으로 줄인다:
 *   1) 긴 문자열·배열·깊은 중첩 자르기, breadcrumbs 는 최근 100개만
 *   2) 스택 지역 변수(vars)·앞뒤 소스 줄, extra, 요청 본문, breadcrumbs, 모듈 목록 제거
 * 그래도 넘으면 null — 호출부가 413 으로 거절한다.
 * 잘라낸 이벤트에는 `_lookout_truncated: true` 를 남긴다.
 */
export function limitEventSize(raw: SentryEvent, maxBytes: number = MAX_EVENT_BYTES): LimitedEvent {
  if (jsonBytes(raw) <= maxBytes) return { event: raw, truncated: false };

  // 1단계
  const event = clamp(raw, 0, false) as Record<string, unknown>;
  trimBreadcrumbs(event, MAX_BREADCRUMBS);
  event._lookout_truncated = true;
  if (jsonBytes(event) <= maxBytes) return { event: event as SentryEvent, truncated: true };

  // 2단계 — 덜 중요한 것부터 하나씩 떼면서 다시 잰다.
  const steps: (() => void)[] = [
    () => stripFrameExtras(event),
    () => delete event.extra,
    () => {
      const request = event.request;
      if (request && typeof request === 'object') {
        delete (request as Record<string, unknown>).data;
        delete (request as Record<string, unknown>).cookies;
      }
    },
    () => trimBreadcrumbs(event, 0),
    () => {
      delete event.modules;
      delete event.debug_meta;
      delete event.contexts;
      delete event.threads;
    },
  ];
  for (const step of steps) {
    step();
    if (jsonBytes(event) <= maxBytes) return { event: event as SentryEvent, truncated: true };
  }
  return { event: null, truncated: true };
}
