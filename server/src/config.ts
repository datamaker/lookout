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
};

export function baseUrl(): string {
  return config.publicUrl || `http://localhost:${config.port}`;
}
