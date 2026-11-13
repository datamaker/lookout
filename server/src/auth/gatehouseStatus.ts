/**
 * gatehouse 계정 상태 조회 (사내 공통 계약 A, 클라이언트 쪽).
 *
 * gatehouse 에서 사용자를 비활성화하거나 "세션 종료"를 누르면, 자체 토큰을 가진
 * 이 앱도 1분 안에 끊기게 한다. SSO 로 발급된 토큰을 검증할 때마다 묻는다.
 *
 *   GET {GATEHOUSE_STATUS_URL}/internal/account?email=…   헤더 X-Gatehouse-Secret
 *   200 {"email","active":bool,"revoked_before": ISO8601|null}   404 {"active":false}
 *
 * - URL·시크릿 중 하나라도 없으면 기능이 꺼진다(항상 통과).
 * - 이메일별 메모리 캐시 60초, 타임아웃 2초.
 * - gatehouse 에 닿지 않거나 5xx·타임아웃이면 마지막으로 성공한 결과를 쓰고,
 *   한 번도 성공한 적이 없으면 통과시킨다 (gatehouse 장애가 이 앱 장애로 번지지 않게).
 */

export interface GatehouseFetchResponse {
  status: number;
  json(): Promise<unknown>;
}

export type GatehouseFetch = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal; redirect: 'error' },
) => Promise<GatehouseFetchResponse>;

export interface GatehouseStatusOptions {
  url?: string;
  secret?: string;
  /** 테스트에서 가짜 fetch 를 끼운다. 기본은 전역 fetch. */
  fetch?: GatehouseFetch;
  now?: () => number;
  warn?: (message: string) => void;
  cacheTtlMs?: number;
  timeoutMs?: number;
  /** 조회 실패 뒤 같은 이메일을 다시 묻기까지의 간격 (실패 중 요청마다 2초씩 매달리지 않게). */
  failureBackoffMs?: number;
}

export type AccountVerdict =
  | { ok: true }
  | { ok: false; reason: 'inactive' | 'revoked' };

export interface GatehouseStatus {
  readonly enabled: boolean;
  /**
   * 이 이메일의 세션·토큰(발급 시각 issuedAtMs)을 받아도 되는지.
   * issuedAtMs 가 없으면 revoked_before 비교는 건너뛴다.
   */
  check(email: string, issuedAtMs?: number | null): Promise<AccountVerdict>;
}

interface AccountState {
  active: boolean;
  revokedBefore: number | null;
}

interface CacheEntry {
  /** 마지막으로 성공한 조회 결과. 한 번도 성공하지 못했으면 null. */
  state: AccountState | null;
  /** 그 결과를 받은 시각. */
  fetchedAt: number;
  /** 마지막 시도가 실패였다면 그 시각 (백오프용). */
  failedAt: number;
}

const MAX_CACHE_ENTRIES = 5000;
const WARN_INTERVAL_MS = 60_000;

export function createGatehouseStatus(opts: GatehouseStatusOptions = {}): GatehouseStatus {
  const base = (opts.url ?? '').replace(/\/+$/, '');
  const secret = opts.secret ?? '';
  const enabled = Boolean(base && secret);
  const doFetch: GatehouseFetch =
    opts.fetch ?? ((url, init) => fetch(url, init) as Promise<GatehouseFetchResponse>);
  const now = opts.now ?? Date.now;
  const warn = opts.warn ?? ((m: string) => console.warn(m));
  const ttl = opts.cacheTtlMs ?? 60_000;
  const timeoutMs = opts.timeoutMs ?? 2000;
  const backoff = opts.failureBackoffMs ?? 10_000;

  const cache = new Map<string, CacheEntry>();
  const inflight = new Map<string, Promise<AccountState | null>>();
  let lastWarnAt = -Infinity;

  /** 경고 로그는 분당 1줄. */
  function warnLimited(message: string): void {
    const t = now();
    if (t - lastWarnAt < WARN_INTERVAL_MS) return;
    lastWarnAt = t;
    warn(`[gatehouse-status] ${message}`);
  }

  function remember(email: string, entry: CacheEntry): void {
    if (!cache.has(email) && cache.size >= MAX_CACHE_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(email, entry);
  }

  /** 실제 조회. 성공하면 상태를, 실패(연결 불가·5xx·타임아웃·401 등)면 null 을 돌려준다. */
  async function fetchState(email: string): Promise<AccountState | null> {
    try {
      const res = await doFetch(`${base}/internal/account?email=${encodeURIComponent(email)}`, {
        headers: { 'X-Gatehouse-Secret': secret, Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
        // 리다이렉트를 따라가면 시크릿 헤더가 다른 곳으로 샐 수 있다.
        redirect: 'error',
      });
      if (res.status === 404) return { active: false, revokedBefore: null };
      if (res.status !== 200) {
        warnLimited(`account lookup responded ${res.status}; using last known result`);
        return null;
      }
      const body = (await res.json()) as { active?: unknown; revoked_before?: unknown };
      if (typeof body?.active !== 'boolean') {
        warnLimited('account lookup returned an unexpected body; using last known result');
        return null;
      }
      let revokedBefore: number | null = null;
      if (typeof body.revoked_before === 'string') {
        const t = Date.parse(body.revoked_before);
        if (!Number.isNaN(t)) revokedBefore = t;
      }
      return { active: body.active, revokedBefore };
    } catch (err) {
      warnLimited(`account lookup failed (${(err as Error).message}); using last known result`);
      return null;
    }
  }

  async function lookup(email: string): Promise<AccountState | null> {
    const t = now();
    const entry = cache.get(email);
    if (entry) {
      if (entry.state && t - entry.fetchedAt < ttl) return entry.state;
      if (entry.failedAt && t - entry.failedAt < backoff) return entry.state;
    }

    // 같은 이메일에 대한 동시 요청은 조회 한 번을 같이 기다린다.
    let pending = inflight.get(email);
    if (!pending) {
      pending = fetchState(email)
        .then((state) => {
          const prev = cache.get(email);
          if (state) {
            remember(email, { state, fetchedAt: now(), failedAt: 0 });
            return state;
          }
          remember(email, {
            state: prev?.state ?? null,
            fetchedAt: prev?.fetchedAt ?? 0,
            failedAt: now(),
          });
          return prev?.state ?? null;
        })
        .finally(() => inflight.delete(email));
      inflight.set(email, pending);
    }
    return pending;
  }

  return {
    enabled,
    async check(rawEmail, issuedAtMs) {
      if (!enabled) return { ok: true };
      const email = rawEmail.trim().toLowerCase();
      if (!email) return { ok: true };
      const state = await lookup(email);
      // 한 번도 성공한 적이 없으면 통과.
      if (!state) return { ok: true };
      if (!state.active) return { ok: false, reason: 'inactive' };
      if (
        state.revokedBefore !== null &&
        typeof issuedAtMs === 'number' &&
        issuedAtMs < state.revokedBefore
      ) {
        return { ok: false, reason: 'revoked' };
      }
      return { ok: true };
    },
  };
}
