/**
 * DB 가 필요한 테스트의 공통 준비물.
 *
 * 로컬 Postgres 가 필요하다 (`docker compose -f docker-compose.dev.yml up -d`, 또는
 * TEST_DATABASE_URL 로 다른 서버 지정). 개발 DB 를 더럽히지 않도록 임시
 * 데이터베이스를 만들어 쓰고 끝나면 지운다.
 */
import pg from 'pg';

const ADMIN_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://lookout:lookout@localhost:5434/lookout';

async function adminQuery(sql: string): Promise<void> {
  const client = new pg.Client({ connectionString: ADMIN_URL });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

export interface TestDb {
  drop(): Promise<void>;
}

/**
 * 임시 데이터베이스를 만들고 DATABASE_URL / JWT_SECRET 을 그쪽으로 맞춘다.
 * config·pool 은 import 시점에 환경변수를 읽으므로, 이걸 부른 "뒤에" src 모듈을 동적 import 해야 한다.
 */
export async function createTestDb(label: string): Promise<TestDb> {
  const name = `lookout_test_${label}_${process.pid}_${Date.now()}`;
  await adminQuery(`CREATE DATABASE ${name}`);
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  process.env.DATABASE_URL = url.toString();
  process.env.JWT_SECRET = 'test-secret';
  delete process.env.OIDC_ISSUER;
  return {
    drop: () => adminQuery(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`),
  };
}
