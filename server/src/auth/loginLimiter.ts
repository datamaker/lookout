/**
 * 비밀번호 로그인 시도 제한 (무차별 대입 방어).
 *
 * IP 별·이메일별로 실패 횟수를 세고, 창(lockoutMs) 안에 한도를 넘으면 그만큼 잠근다.
 * 잠긴 동안은 비밀번호 비교(bcrypt) 자체를 하지 않는다.
 *
 * 동시 요청으로 한도를 우회하지 못하게 "시도"를 먼저 세고(consume), 로그인에
 * 성공하면 되돌려 준다(success). 서버 한 대 기준의 메모리 카운터다.
 */

export interface LoginLimiterOptions {
  /** 이메일당 허용 실패 횟수. 0 이면 이메일 기준 제한을 끈다. */
  maxPerEmail: number;
  /** IP 당 허용 실패 횟수. 0 이면 IP 기준 제한을 끈다. */
  maxPerIp: number;
  /** 실패를 세는 창이자 잠금 시간. */
  lockoutMs: number;
  now?: () => number;
}

export interface LoginLimiter {
  /** 시도 1회를 기록한다. 0 이면 진행해도 되고, 양수면 그 초만큼 기다려야 한다(잠김). */
  consume(ip: string, email: string): number;
  /** 로그인 성공: 이 이메일의 실패 기록을 지우고, IP 쪽에 센 이번 시도를 되돌린다. */
  success(ip: string, email: string): void;
}

interface Entry {
  count: number;
  windowStart: number;
  lockedUntil: number;
}

const MAX_ENTRIES = 50_000;

export function createLoginLimiter(opts: LoginLimiterOptions): LoginLimiter {
  const now = opts.now ?? Date.now;
  const entries = new Map<string, Entry>();

  const emailKey = (email: string) => `e:${email.trim().toLowerCase().slice(0, 320)}`;
  const ipKey = (ip: string) => `i:${ip}`;

  function prune(t: number): void {
    for (const [key, e] of entries) {
      if (t >= e.lockedUntil && t - e.windowStart >= opts.lockoutMs) entries.delete(key);
    }
    // 그래도 넘치면 오래된 것부터 버린다 (무작위 이메일을 뿌려 메모리를 채우는 공격 대비).
    while (entries.size >= MAX_ENTRIES) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
  }

  /** 남은 잠금 시간(초). 잠기지 않았으면 0. */
  function lockedFor(key: string, t: number): number {
    const e = entries.get(key);
    return e && t < e.lockedUntil ? Math.max(1, Math.ceil((e.lockedUntil - t) / 1000)) : 0;
  }

  function hit(key: string, max: number, t: number): void {
    let e = entries.get(key);
    if (!e || (t >= e.lockedUntil && t - e.windowStart >= opts.lockoutMs)) {
      if (!e && entries.size >= MAX_ENTRIES) prune(t);
      e = { count: 0, windowStart: t, lockedUntil: 0 };
      entries.set(key, e);
    }
    e.count += 1;
    if (e.count >= max) {
      // 한도에 닿은 시도까지는 처리하고, 그 다음부터 잠근다.
      e.lockedUntil = t + opts.lockoutMs;
      e.count = 0;
      e.windowStart = t;
    }
  }

  return {
    consume(ip, email) {
      const t = now();
      const waits = [
        opts.maxPerIp > 0 ? lockedFor(ipKey(ip), t) : 0,
        opts.maxPerEmail > 0 ? lockedFor(emailKey(email), t) : 0,
      ];
      const wait = Math.max(...waits);
      if (wait > 0) return wait;
      if (opts.maxPerIp > 0) hit(ipKey(ip), opts.maxPerIp, t);
      if (opts.maxPerEmail > 0) hit(emailKey(email), opts.maxPerEmail, t);
      return 0;
    },
    success(ip, email) {
      entries.delete(emailKey(email));
      const e = entries.get(ipKey(ip));
      if (e) {
        // 이번 시도가 마지막 한 칸을 채워 잠금을 걸었더라도, 성공했으니 푼다.
        if (e.count === 0 && e.lockedUntil > 0) {
          e.lockedUntil = 0;
          e.count = Math.max(0, opts.maxPerIp - 1);
        } else if (e.count > 0) {
          e.count -= 1;
        }
      }
    },
  };
}
