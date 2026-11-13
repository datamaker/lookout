/** LOOKOUT_TRUST_PROXY: 숫자(프록시 홉 수), true/false, 또는 신뢰할 프록시 IP/CIDR 목록. */
function parseTrustProxy(raw: string | undefined): boolean | number | string {
  const v = (raw ?? '').trim();
  if (!v || v === 'false' || v === '0') return false;
  if (v === 'true') return true;
  if (/^\d+$/.test(v)) return parseInt(v, 10);
  return v;
}

function intEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : fallback;
}

export const config = {
  port: parseInt(process.env.PORT ?? '9000', 10),
  host: process.env.HOST ?? '0.0.0.0',
  databaseUrl:
    process.env.DATABASE_URL ??
    'postgres://lookout:lookout@localhost:5434/lookout',
  /** Days to keep raw events. Issues (grouped rows) are kept forever. */
  retentionDays: parseInt(process.env.LOOKOUT_RETENTION_DAYS ?? '90', 10),
  /** Public base URL, used to build DSNs and links in alerts, e.g. https://lookout.example.com */
  publicUrl: (process.env.LOOKOUT_PUBLIC_URL ?? '').replace(/\/$/, ''),
  /** OIDC SSO (optional): issuer of the internal IdP, e.g. https://auth.datasee.co.kr/oidc */
  oidcIssuer: (process.env.OIDC_ISSUER ?? '').replace(/\/$/, ''),
  oidcClientId: process.env.OIDC_CLIENT_ID ?? 'lookout',
  oidcClientSecret: process.env.OIDC_CLIENT_SECRET ?? '',
  /** Separate public client for the CLI's device flow (audience of its id_tokens). */
  oidcCliClientId: process.env.OIDC_CLI_CLIENT_ID ?? 'lookout-cli',
  /** 프록시 뒤 실제 클라이언트 IP 판별 (Fastify trustProxy). 기본: 믿지 않음. */
  trustProxy: parseTrustProxy(process.env.LOOKOUT_TRUST_PROXY),
  /** 비밀번호 로그인 시도 제한. 0 이면 해당 제한을 끈다. */
  loginMaxFailuresPerEmail: intEnv('LOGIN_MAX_FAILURES_PER_EMAIL', 5),
  loginMaxFailuresPerIp: intEnv('LOGIN_MAX_FAILURES_PER_IP', 20),
  loginLockoutMinutes: intEnv('LOGIN_LOCKOUT_MINUTES', 15) || 15,
  /** gatehouse 계정 상태 조회 (둘 다 있어야 켜진다). */
  gatehouseStatusUrl: (process.env.GATEHOUSE_STATUS_URL ?? '').replace(/\/$/, ''),
  gatehouseStatusSecret: process.env.GATEHOUSE_STATUS_SECRET ?? '',
  /**
   * 알림 웹훅으로 허용할 호스트(쉼표 구분). 기본은 hooks.slack.com 만.
   * '*' 를 넣으면 아무 호스트(http 포함)나 허용한다 — 셀프호스트·개발용.
   */
  webhookAllowedHosts: (process.env.LOOKOUT_WEBHOOK_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean),
};

export function baseUrl(): string {
  return config.publicUrl || `http://localhost:${config.port}`;
}
