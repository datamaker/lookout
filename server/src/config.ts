export const config = {
  port: parseInt(process.env.PORT ?? '9000', 10),
  host: process.env.HOST ?? '0.0.0.0',
  databaseUrl:
    process.env.DATABASE_URL ??
    'postgres://lookout:lookout@localhost:5434/lookout',
  /** Password for the web dashboard. Ingestion is authenticated per-project by DSN key. */
  adminPassword: process.env.LOOKOUT_ADMIN_PASSWORD ?? 'lookout',
  /** Days to keep raw events. Issues (grouped rows) are kept forever. */
  retentionDays: parseInt(process.env.LOOKOUT_RETENTION_DAYS ?? '90', 10),
  /** Public base URL, used to build DSNs and links in alerts, e.g. https://lookout.example.com */
  publicUrl: (process.env.LOOKOUT_PUBLIC_URL ?? '').replace(/\/$/, ''),
};

export function baseUrl(): string {
  return config.publicUrl || `http://localhost:${config.port}`;
}
