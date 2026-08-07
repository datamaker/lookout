import { pool } from './pool.js';

const migrations: { name: string; sql: string }[] = [
  {
    name: '001_initial',
    sql: `
      CREATE TABLE projects (
        id SERIAL PRIMARY KEY,
        slug TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        public_key TEXT UNIQUE NOT NULL,
        webhook_url TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE issues (
        id SERIAL PRIMARY KEY,
        project_id INT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        fingerprint TEXT NOT NULL,
        title TEXT NOT NULL,
        culprit TEXT,
        level TEXT NOT NULL DEFAULT 'error',
        status TEXT NOT NULL DEFAULT 'unresolved',
        event_count BIGINT NOT NULL DEFAULT 0,
        first_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (project_id, fingerprint)
      );
      CREATE INDEX issues_project_last_seen ON issues (project_id, last_seen DESC);

      CREATE TABLE events (
        id UUID PRIMARY KEY,
        project_id INT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        issue_id INT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
        timestamp TIMESTAMPTZ NOT NULL,
        level TEXT,
        message TEXT,
        environment TEXT,
        release TEXT,
        payload JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX events_issue_ts ON events (issue_id, timestamp DESC);
      CREATE INDEX events_project_ts ON events (project_id, timestamp DESC);
    `,
  },
  {
    name: '002_users',
    sql: `
      CREATE TABLE users (
        id SERIAL PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
        is_active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `,
  },
];

export async function migrate(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  const { rows } = await pool.query<{ name: string }>('SELECT name FROM _migrations');
  const applied = new Set(rows.map((r) => r.name));

  for (const m of migrations) {
    if (applied.has(m.name)) continue;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(m.sql);
      await client.query('INSERT INTO _migrations (name) VALUES ($1)', [m.name]);
      await client.query('COMMIT');
      console.log(`migrated: ${m.name}`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  migrate()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
