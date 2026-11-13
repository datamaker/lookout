/**
 * 인증 게이트 회귀 테스트.
 *
 * 운영에서 재현된 우회: 인증 여부를 원본 URL 접두사로 정했는데 라우터는 경로를
 * 디코딩해서 매칭하므로, GET /%61pi/projects 가 토큰 없이 프로젝트 목록(DSN 키,
 * 슬랙 웹훅 URL)을 돌려줬다. 같은 구멍이 다시 열리면 여기서 걸려야 한다.
 *
 * 로컬 Postgres 가 필요하다 (`docker compose -f docker-compose.dev.yml up -d`).
 * 개발 DB 를 더럽히지 않도록 임시 데이터베이스를 만들어 쓰고 끝나면 지운다.
 * 다른 서버를 쓰려면 TEST_DATABASE_URL 로 지정한다.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';

const ADMIN_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://lookout:lookout@localhost:5434/lookout';
const TEST_DB = `lookout_test_${process.pid}_${Date.now()}`;
const PUBLIC_KEY = 'testkey0123456789abcdef';
// 새 이슈 알림이 실제로 밖으로 나가지 않게, 바로 거절되는 로컬 주소를 쓴다.
const WEBHOOK_URL = 'http://127.0.0.1:9/secret-hook';

let app: FastifyInstance; // 정적 파일 없이 (API 만)
let appWithWeb: FastifyInstance; // 대시보드 정적 파일 + SPA 폴백 포함 (운영과 같은 구성)
let webDist: string;
let closePool: () => Promise<void>;
let token: string; // member 권한 토큰
let adminToken: string;
let projectId: number;
let issueId: number;

async function adminQuery(sql: string): Promise<void> {
  const client = new pg.Client({ connectionString: ADMIN_URL });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

before(async () => {
  await adminQuery(`CREATE DATABASE ${TEST_DB}`);
  const url = new URL(ADMIN_URL);
  url.pathname = `/${TEST_DB}`;
  // config/pool 은 import 시점에 환경변수를 읽으므로, 값을 넣은 뒤에 동적 import 한다.
  process.env.DATABASE_URL = url.toString();
  process.env.JWT_SECRET = 'test-secret';
  delete process.env.OIDC_ISSUER;

  const { migrate } = await import('../src/db/migrate.js');
  const { pool, query } = await import('../src/db/pool.js');
  const { initAuth, signToken } = await import('../src/auth/service.js');
  const { buildApp } = await import('../src/app.js');
  closePool = () => pool.end();

  await migrate();
  await initAuth();

  const users = await query<{ id: number; email: string; role: 'admin' | 'member' }>(
    `INSERT INTO users (email, name, password_hash, role) VALUES
       ('admin@example.com', 'Admin', 'x', 'admin'),
       ('member@example.com', 'Member', 'x', 'member')
     RETURNING id, email, role`,
  );
  const asUser = (role: string) => {
    const u = users.rows.find((r) => r.role === role)!;
    return signToken({ ...u, name: u.email, is_active: true });
  };
  adminToken = asUser('admin');
  token = asUser('member');

  const project = await query<{ id: number }>(
    `INSERT INTO projects (slug, name, public_key, webhook_url)
     VALUES ('demo', 'Demo', $1, $2) RETURNING id`,
    [PUBLIC_KEY, WEBHOOK_URL],
  );
  projectId = project.rows[0].id;
  const issue = await query<{ id: number }>(
    `INSERT INTO issues (project_id, fingerprint, title) VALUES ($1, 'fp', 'boom') RETURNING id`,
    [projectId],
  );
  issueId = issue.rows[0].id;

  webDist = mkdtempSync(path.join(tmpdir(), 'lookout-web-'));
  writeFileSync(path.join(webDist, 'index.html'), '<!doctype html><title>lookout spa</title>');

  app = await buildApp();
  appWithWeb = await buildApp({ webDist });
  await app.ready();
  await appWithWeb.ready();
});

after(async () => {
  await app?.close();
  await appWithWeb?.close();
  await closePool?.();
  if (webDist) rmSync(webDist, { recursive: true, force: true });
  await adminQuery(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
});

const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

/** 응답에 대시보드 데이터가 새지 않았는지 — 본문에 DSN 키나 웹훅 URL 이 없어야 한다. */
function assertNoLeak(body: string): void {
  assert.ok(!body.includes(PUBLIC_KEY), 'DSN 키가 응답에 노출됨');
  assert.ok(!body.includes('secret-hook'), '웹훅 URL 이 응답에 노출됨');
}

async function issueStatus(): Promise<string> {
  const { query } = await import('../src/db/pool.js');
  const { rows } = await query<{ status: string }>('SELECT status FROM issues WHERE id = $1', [
    issueId,
  ]);
  return rows[0].status;
}

/** 두 구성(API 만 / 정적 파일 포함) 모두에서 같은 검사를 돌린다. */
function eachApp(fn: (a: FastifyInstance, label: string) => Promise<void>): () => Promise<void> {
  return async () => {
    await fn(app, 'api-only');
    await fn(appWithWeb, 'with-web');
  };
}

describe('대시보드 API 는 토큰 없이 열리지 않는다', () => {
  test(
    'GET /api/projects → 401',
    eachApp(async (a, label) => {
      const res = await a.inject({ method: 'GET', url: '/api/projects' });
      assert.equal(res.statusCode, 401, label);
      assertNoLeak(res.body);
    }),
  );

  test(
    '잘못된 토큰 → 401',
    eachApp(async (a, label) => {
      const res = await a.inject({
        method: 'GET',
        url: '/api/projects',
        headers: bearer('not-a-jwt'),
      });
      assert.equal(res.statusCode, 401, label);
    }),
  );

  // 경로를 꼬아서 인증 판단과 라우터 매칭을 어긋나게 하려는 시도들.
  const bypassUrls = [
    '/%61pi/projects',
    '/%41pi/projects',
    '/api%2Fprojects',
    // '/%61pi/projects;x/../../healthz' 는 아래 실제 소켓 테스트에서 본다 —
    // inject 는 보내기 전에 '..' 을 접어서 '/healthz' 로 바꿔 버린다.
    '/api/projects;x',
    '/api/projects;x=1',
    '/%61pi/projects;x',
    '/%2Fapi/projects',
    '//api/projects',
    '/api//projects',
    '/API/projects',
    '/api/projects/',
    '/api/%70rojects',
    '/%61pi/projects/1/issues',
    '/%61pi/users',
    '/%61pi/auth/me',
  ];
  for (const url of bypassUrls) {
    test(
      `GET ${url} → 401/404, 데이터 없음`,
      eachApp(async (a, label) => {
        const res = await a.inject({ method: 'GET', url });
        assert.ok(
          [401, 404].includes(res.statusCode),
          `${label}: ${url} → ${res.statusCode} ${res.body.slice(0, 80)}`,
        );
        assertNoLeak(res.body);
      }),
    );
  }

  test(
    'PATCH 이슈 상태 변경은 어떤 경로 표기로도 토큰 없이 안 된다',
    eachApp(async (a, label) => {
      for (const url of [
        `/api/issues/${issueId}`,
        `/%61pi/issues/${issueId}`,
        `/%41pi/issues/${issueId}`,
        `/api%2Fissues/${issueId}`,
        `/api/issues/${issueId};x`,
      ]) {
        const res = await a.inject({ method: 'PATCH', url, payload: { status: 'resolved' } });
        assert.ok([401, 404].includes(res.statusCode), `${label}: ${url} → ${res.statusCode}`);
      }
      assert.equal(await issueStatus(), 'unresolved', label);
    }),
  );

  test(
    '상태를 바꾸는 라우트는 전부 토큰 없이 401',
    eachApp(async (a, label) => {
      const routes: [string, string][] = [
        ['POST', '/api/projects'],
        ['PATCH', `/api/projects/${projectId}`],
        ['DELETE', `/api/projects/${projectId}`],
        ['PATCH', `/api/issues/${issueId}`],
        ['POST', '/api/users'],
        ['PATCH', '/api/users/1'],
        ['DELETE', '/api/users/1'],
        ['PUT', '/api/auth/password'],
      ];
      for (const [method, url] of routes) {
        const res = await a.inject({ method: method as 'POST', url, payload: {} });
        assert.equal(res.statusCode, 401, `${label}: ${method} ${url}`);
      }
    }),
  );

  test(
    '읽기 라우트도 전부 토큰 없이 401',
    eachApp(async (a, label) => {
      for (const url of [
        `/api/projects/${projectId}/issues`,
        `/api/projects/${projectId}/stats`,
        `/api/issues/${issueId}`,
        `/api/issues/${issueId}/events`,
        '/api/events/00000000-0000-0000-0000-000000000000',
        '/api/users',
        '/api/auth/me',
      ]) {
        const res = await a.inject({ method: 'GET', url });
        assert.equal(res.statusCode, 401, `${label}: ${url}`);
        // HEAD 로도 마찬가지 (fastify 가 GET 라우트마다 HEAD 를 같이 만든다).
        const head = await a.inject({ method: 'HEAD', url });
        assert.equal(head.statusCode, 401, `${label}: HEAD ${url}`);
      }
    }),
  );

  test('등록된 모든 라우트는 공개 목록에 있거나 토큰 없이 401 이다 (기본 거부)', async () => {
    const { PUBLIC_ROUTES } = await import('../src/auth/gate.js');
    // 게이트보다 늦게 추가된 라우트도 보호되는지 본다.
    const { buildApp } = await import('../src/app.js');
    const fresh = await buildApp();
    const seen: string[] = [];
    fresh.addHook('onRoute', (r) => {
      for (const m of [r.method].flat()) seen.push(`${m} ${r.url}`);
    });
    fresh.get('/api/new-thing', async () => ({ secret: true }));
    fresh.get('/internal/new-thing', async () => ({ secret: true }));
    await fresh.ready();
    assert.ok(seen.includes('GET /api/new-thing'));
    for (const key of seen) {
      const [method, url] = key.split(' ');
      const res = await fresh.inject({ method: method as 'GET', url });
      assert.equal(PUBLIC_ROUTES.has(key.replace(/^HEAD /, 'GET ')), false);
      assert.equal(res.statusCode, 401, key);
    }
    await fresh.close();
  });

  // inject 가 URL 을 정규화했을 가능성을 배제하려고, 실제 소켓으로 원본 경로를 그대로 보낸다.
  test('실제 HTTP 소켓으로 보낸 원본 경로도 막힌다', async () => {
    await appWithWeb.listen({ port: 0, host: '127.0.0.1' });
    const { port } = appWithWeb.server.address() as AddressInfo;
    const raw = (method: string, p: string) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, method, path: p }, (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        });
        req.on('error', reject);
        req.end();
      });
    for (const p of [
      '/%61pi/projects',
      '/%41pi/projects',
      '/api%2Fprojects',
      '/%61pi/projects;x/../../healthz',
      '/api/projects;x',
    ]) {
      const res = await raw('GET', p);
      assert.ok([401, 404].includes(res.status), `${p} → ${res.status}`);
      assertNoLeak(res.body);
    }
    const patch = await raw('PATCH', `/%61pi/issues/${issueId}`);
    assert.ok([401, 404].includes(patch.status));
    assert.equal((await raw('GET', '/api/projects')).status, 401);
    assert.equal((await raw('GET', '/healthz')).status, 200);
  });
});

describe('공개 라우트는 토큰 없이 그대로 동작한다', () => {
  test(
    'GET /healthz → 200',
    eachApp(async (a, label) => {
      const res = await a.inject({ method: 'GET', url: '/healthz' });
      assert.equal(res.statusCode, 200, label);
      assert.deepEqual(res.json(), { ok: true });
    }),
  );

  test(
    'SDK envelope 수집은 DSN 키만으로 된다',
    eachApp(async (a, label) => {
      const eventId = 'a'.repeat(32);
      const envelope =
        [
          JSON.stringify({ event_id: eventId }),
          JSON.stringify({ type: 'event' }),
          JSON.stringify({ event_id: eventId, message: `gate test ${label}`, level: 'error' }),
        ].join('\n') + '\n';
      // @sentry/node v7 처럼 Content-Type 없이 보낸다.
      const res = await a.inject({
        method: 'POST',
        url: `/api/${projectId}/envelope/`,
        headers: { 'x-sentry-auth': `Sentry sentry_version=7, sentry_key=${PUBLIC_KEY}` },
        payload: Buffer.from(envelope),
      });
      assert.equal(res.statusCode, 200, `${label}: ${res.body}`);
      assert.ok(res.json().id);
    }),
  );

  test(
    'SDK store 수집(sentry_key 쿼리)도 DSN 키만으로 된다',
    eachApp(async (a, label) => {
      const res = await a.inject({
        method: 'POST',
        url: `/api/${projectId}/store/?sentry_key=${PUBLIC_KEY}`,
        payload: { message: `store test ${label}`, level: 'error' },
      });
      assert.equal(res.statusCode, 200, `${label}: ${res.body}`);
    }),
  );

  test(
    'DSN 키가 틀리면 수집은 401',
    eachApp(async (a, label) => {
      const res = await a.inject({
        method: 'POST',
        url: `/api/${projectId}/envelope/?sentry_key=wrong`,
        payload: Buffer.from('{}\n'),
      });
      assert.equal(res.statusCode, 401, label);
    }),
  );

  test(
    '로그인 전 인증 라우트는 열려 있다',
    eachApp(async (a, label) => {
      const status = await a.inject({ method: 'GET', url: '/api/auth/status' });
      assert.equal(status.statusCode, 200, label);
      assert.deepEqual(status.json(), { needsSetup: false });

      const oidc = await a.inject({ method: 'GET', url: '/api/auth/oidc/status' });
      assert.equal(oidc.statusCode, 200, label);
      assert.deepEqual(oidc.json(), { enabled: false });

      // 게이트를 지나 핸들러까지 간다: 자격증명 누락 400, 틀린 비밀번호 401(핸들러의 메시지).
      const login = await a.inject({ method: 'POST', url: '/api/auth/login', payload: {} });
      assert.equal(login.statusCode, 400, label);

      // 이미 사용자가 있으므로 setup 은 핸들러가 403 으로 막는다.
      const setup = await a.inject({ method: 'POST', url: '/api/auth/setup', payload: {} });
      assert.equal(setup.statusCode, 403, label);

      // SSO 미설정이면 핸들러가 404.
      for (const [method, url] of [
        ['GET', '/api/auth/oidc/start'],
        ['GET', '/api/auth/oidc/callback'],
        ['POST', '/api/auth/oidc/exchange'],
      ]) {
        const res = await a.inject({ method: method as 'GET', url, payload: {} });
        assert.equal(res.statusCode, 404, `${label}: ${method} ${url}`);
        assert.deepEqual(res.json(), { error: 'sso not configured' });
      }
    }),
  );

  test(
    'CORS preflight 는 인증 없이 통과한다',
    eachApp(async (a, label) => {
      const res = await a.inject({
        method: 'OPTIONS',
        url: '/api/projects',
        headers: {
          origin: 'http://localhost:5173',
          'access-control-request-method': 'GET',
        },
      });
      assert.equal(res.statusCode, 204, label);
    }),
  );
});

describe('로그인한 사용자', () => {
  test(
    '프로젝트 목록을 본다',
    eachApp(async (a, label) => {
      const res = await a.inject({ method: 'GET', url: '/api/projects', headers: bearer(token) });
      assert.equal(res.statusCode, 200, label);
      const projects = res.json() as { id: number; public_key: string }[];
      assert.equal(projects[0].id, projectId);
      assert.equal(projects[0].public_key, PUBLIC_KEY);
    }),
  );

  test(
    '/api/auth/me 가 본인을 돌려준다',
    eachApp(async (a, label) => {
      const res = await a.inject({ method: 'GET', url: '/api/auth/me', headers: bearer(token) });
      assert.equal(res.statusCode, 200, label);
      assert.equal(res.json().user.email, 'member@example.com');
    }),
  );

  test('member 는 이슈 상태를 바꿀 수 있다 (역할 구분은 그대로)', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/issues/${issueId}`,
      headers: bearer(token),
      payload: { status: 'resolved' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(await issueStatus(), 'resolved');
    await app.inject({
      method: 'PATCH',
      url: `/api/issues/${issueId}`,
      headers: bearer(token),
      payload: { status: 'unresolved' },
    });
  });

  test('admin 전용 라우트: member 는 403, admin 은 통과', async () => {
    const asMember = await app.inject({ method: 'GET', url: '/api/users', headers: bearer(token) });
    assert.equal(asMember.statusCode, 403);
    const create = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: bearer(token),
      payload: { name: 'nope' },
    });
    assert.equal(create.statusCode, 403);
    const asAdmin = await app.inject({
      method: 'GET',
      url: '/api/users',
      headers: bearer(adminToken),
    });
    assert.equal(asAdmin.statusCode, 200);
    assert.equal(asAdmin.json().length, 2);
  });

  test('비활성화된 사용자의 토큰은 401', async () => {
    const { query } = await import('../src/db/pool.js');
    await query(`UPDATE users SET is_active = false WHERE email = 'member@example.com'`);
    try {
      const res = await app.inject({ method: 'GET', url: '/api/projects', headers: bearer(token) });
      assert.equal(res.statusCode, 401);
    } finally {
      await query(`UPDATE users SET is_active = true WHERE email = 'member@example.com'`);
    }
  });
});

describe('정적 파일 / SPA 폴백', () => {
  test('대시보드 경로는 토큰 없이 index.html 을 받는다', async () => {
    for (const url of ['/', '/index.html', '/login', '/projects/1/issues']) {
      const res = await appWithWeb.inject({ method: 'GET', url });
      assert.equal(res.statusCode, 200, url);
      assert.match(res.body, /lookout spa/, url);
    }
  });

  test('API 처럼 보이는 경로는 SPA 폴백으로 200 이 되지 않는다', async () => {
    for (const url of [
      '/api/nope',
      '/api',
      '/%61pi/nope',
      '/api%2Fprojects',
      '/%2Fapi/projects',
      '//api/projects',
      '/API/projects',
      '/api/%ZZ',
    ]) {
      const res = await appWithWeb.inject({ method: 'GET', url });
      assert.ok([400, 401, 404].includes(res.statusCode), `${url} → ${res.statusCode}`);
      assert.doesNotMatch(res.body, /lookout spa/, url);
    }
  });

  test('GET 이 아닌 요청은 SPA 폴백을 타지 않는다', async () => {
    const res = await appWithWeb.inject({ method: 'POST', url: '/login', payload: {} });
    assert.equal(res.statusCode, 404);
  });
});
