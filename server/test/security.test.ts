/**
 * 보안 수정 통합 테스트 (실제 앱 + 임시 DB).
 *  - 수집: 압축 폭탄 거절, 정상 gzip 수락, 큰 이벤트 처리, 본문 한도, 분당 바이트 한도
 *  - 비밀번호 로그인 시도 제한
 *  - gatehouse 계정 상태 확인 (SSO 토큰만 대상, 가짜 fetch 주입)
 *  - 웹훅 URL 저장 검증
 * DB 준비 방법은 helpers.ts 참고.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import type { FastifyInstance } from 'fastify';
import { createTestDb, type TestDb } from './helpers.js';

const MB = 1024 * 1024;
const KEY = 'seckey0123456789abcdef';

let db: TestDb;
let app: FastifyInstance;
let closePool: () => Promise<void>;
let q: typeof import('../src/db/pool.js').query;
let svc: typeof import('../src/auth/service.js');
let gh: typeof import('../src/auth/gatehouseStatus.js');
const projects: Record<string, number> = {};
let admin: { id: number; email: string; name: string; role: 'admin'; is_active: boolean };

before(async () => {
  db = await createTestDb('sec');
  // 바이트 한도 테스트가 빨리 닿도록 작게 잡는다 (모듈 import 전에 설정).
  process.env.INGEST_BYTES_LIMIT_PER_MIN = String(3 * MB);
  delete process.env.GATEHOUSE_STATUS_URL;
  delete process.env.GATEHOUSE_STATUS_SECRET;

  const { migrate } = await import('../src/db/migrate.js');
  const pool = await import('../src/db/pool.js');
  svc = await import('../src/auth/service.js');
  gh = await import('../src/auth/gatehouseStatus.js');
  const { buildApp } = await import('../src/app.js');
  q = pool.query;
  closePool = () => pool.pool.end();

  await migrate();
  await svc.initAuth();

  const hash = await svc.hashPassword('correct-horse');
  const users = await q<typeof admin>(
    `INSERT INTO users (email, name, password_hash, role) VALUES
       ('admin@example.com', 'Admin', $1, 'admin'),
       ('victim@example.com', 'Victim', $1, 'member'),
       ('other@example.com', 'Other', $1, 'member')
     RETURNING id, email, name, role, is_active`,
    [hash],
  );
  admin = users.rows[0];

  for (const slug of ['main', 'big', 'bytes']) {
    const { rows } = await q<{ id: number }>(
      `INSERT INTO projects (slug, name, public_key) VALUES ($1, $1, $2) RETURNING id`,
      [slug, `${KEY}${slug}`],
    );
    projects[slug] = rows[0].id;
  }

  app = await buildApp();
  await app.ready();
});

after(async () => {
  await app?.close();
  await closePool?.();
  await db?.drop();
});

function envelopeOf(event: Record<string, unknown>): Buffer {
  return Buffer.from(
    [
      JSON.stringify({ event_id: event.event_id }),
      JSON.stringify({ type: 'event' }),
      JSON.stringify(event),
    ].join('\n'),
  );
}

function postEnvelope(slug: string, body: Buffer, headers: Record<string, string> = {}) {
  return app.inject({
    method: 'POST',
    url: `/api/${projects[slug]}/envelope/?sentry_key=${KEY}${slug}`,
    headers: { 'content-type': 'application/x-sentry-envelope', ...headers },
    payload: body,
  });
}

const eventId = (n: number) => n.toString(16).padStart(32, '0');
async function storedPayload(id: string): Promise<Record<string, unknown> | null> {
  const uuid = `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
  const { rows } = await q<{ payload: Record<string, unknown> }>(
    'SELECT payload FROM events WHERE id = $1',
    [uuid],
  );
  return rows[0]?.payload ?? null;
}

describe('수집 — 자원 고갈 방어', () => {
  test('정상 gzip envelope 은 200 으로 받고 저장한다', async () => {
    const id = eventId(1);
    const res = await postEnvelope(
      'main',
      gzipSync(envelopeOf({ event_id: id, message: 'hello gzip' })),
      { 'content-encoding': 'gzip' },
    );
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().id, id);
    assert.equal((await storedPayload(id))?.message, 'hello gzip');
  });

  test('Content-Type 없이 온 무압축 envelope (@sentry/node v7) 도 그대로 받는다', async () => {
    const id = eventId(2);
    const res = await app.inject({
      method: 'POST',
      url: `/api/${projects.main}/envelope/`,
      headers: { 'x-sentry-auth': `Sentry sentry_version=7, sentry_key=${KEY}main` },
      payload: envelopeOf({ event_id: id, message: 'plain' }),
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.ok(await storedPayload(id));
  });

  test('압축 폭탄(작은 gzip → 50 MB)은 413, 아무것도 저장하지 않는다', async () => {
    const id = eventId(3);
    const bomb = gzipSync(
      envelopeOf({ event_id: id, message: 'bomb', extra: { pad: '0'.repeat(50 * MB) } }),
    );
    assert.ok(bomb.length < 200 * 1024, `폭탄 압축본 크기 ${bomb.length}`);
    const res = await postEnvelope('main', bomb, { 'content-encoding': 'gzip' });
    assert.equal(res.statusCode, 413, res.body);
    assert.equal(await storedPayload(id), null);
  });

  test('store 엔드포인트도 압축 폭탄은 413', async () => {
    const bomb = gzipSync(Buffer.from(JSON.stringify({ message: 'x', extra: { pad: '0'.repeat(50 * MB) } })));
    const res = await app.inject({
      method: 'POST',
      url: `/api/${projects.main}/store/?sentry_key=${KEY}main`,
      headers: { 'content-type': 'application/octet-stream', 'content-encoding': 'gzip' },
      payload: bomb,
    });
    assert.equal(res.statusCode, 413, res.body);
  });

  test('HTTP 본문이 수집 한도(2 MB)를 넘으면 413', async () => {
    const res = await postEnvelope('main', Buffer.alloc(3 * MB, 0x61));
    assert.equal(res.statusCode, 413, res.body);
  });

  test('깨진 gzip 은 400, 모르는 인코딩은 415', async () => {
    const bad = await postEnvelope('main', Buffer.from('not gzip'), { 'content-encoding': 'gzip' });
    assert.equal(bad.statusCode, 400);
    const unknown = await postEnvelope('main', Buffer.from('x'), { 'content-encoding': 'compress' });
    assert.equal(unknown.statusCode, 415);
  });

  test('1 MB 를 넘는 이벤트는 부가 정보를 잘라 저장한다 (200, 저장본 ≤ 1 MB)', async () => {
    const id = eventId(4);
    const event = {
      event_id: id,
      exception: { values: [{ type: 'RangeError', value: 'too big' }] },
      breadcrumbs: Array.from({ length: 3000 }, (_, i) => ({ message: `c${i} ${'x'.repeat(400)}` })),
    };
    const body = envelopeOf(event);
    assert.ok(body.length > MB && body.length < 2 * MB);
    const res = await postEnvelope('big', body);
    assert.equal(res.statusCode, 200, res.body);
    const payload = await storedPayload(id);
    assert.ok(payload);
    assert.ok(Buffer.byteLength(JSON.stringify(payload)) <= MB);
    assert.equal(payload._lookout_truncated, true);
    assert.equal((payload.breadcrumbs as unknown[]).length, 100);
    const { rows } = await q<{ title: string }>(
      'SELECT title FROM issues WHERE project_id = $1',
      [projects.big],
    );
    assert.equal(rows[0].title, 'RangeError: too big');
  });

  test('줄여도 1 MB 를 넘는 이벤트는 413 으로 거절한다', async () => {
    const id = eventId(5);
    const tags: Record<string, string> = {};
    for (let i = 0; i < 200; i++) tags[`t${i}`] = 'q'.repeat(7000);
    const res = await postEnvelope('big', envelopeOf({ event_id: id, message: 'huge tags', tags }));
    assert.equal(res.statusCode, 413, res.body);
    assert.equal(await storedPayload(id), null);
  });

  test('프로젝트별 분당 바이트 한도를 넘으면 429 + Retry-After, 다른 프로젝트는 영향 없음', async () => {
    const big = (n: number) =>
      envelopeOf({ event_id: eventId(100 + n), message: 'm', extra: { pad: 'p'.repeat(900_000) } });
    // 한도 3 MB: 약 0.9 MB 짜리 3건은 통과, 4번째에서 넘는다.
    for (let i = 0; i < 3; i++) {
      const ok = await postEnvelope('bytes', big(i));
      assert.equal(ok.statusCode, 200, `#${i} ${ok.body}`);
    }
    const limited = await postEnvelope('bytes', big(3));
    assert.equal(limited.statusCode, 429, limited.body);
    const retry = Number(limited.headers['retry-after']);
    assert.ok(retry >= 1 && retry <= 60, `Retry-After=${limited.headers['retry-after']}`);

    const other = await postEnvelope('main', envelopeOf({ event_id: eventId(200), message: 'ok' }));
    assert.equal(other.statusCode, 200);
  });
});

describe('비밀번호 로그인 — 시도 제한', () => {
  const login = (email: string, password: string, ip: string) =>
    app.inject({
      method: 'POST',
      url: '/api/auth/login',
      remoteAddress: ip,
      payload: { email, password },
    });

  test('정상 로그인은 그대로 된다', async () => {
    const res = await login('other@example.com', 'correct-horse', '10.0.0.1');
    assert.equal(res.statusCode, 200, res.body);
    assert.ok(res.json().token);
  });

  test('같은 이메일로 5번 틀리면 잠기고, 맞는 비밀번호도 429 (다른 IP 에서도)', async () => {
    for (let i = 0; i < 5; i++) {
      const res = await login('victim@example.com', `wrong-${i}`, '10.0.0.2');
      assert.equal(res.statusCode, 401, `시도 ${i}`);
    }
    const locked = await login('victim@example.com', 'correct-horse', '10.0.0.2');
    assert.equal(locked.statusCode, 429, locked.body);
    assert.ok(Number(locked.headers['retry-after']) > 0);
    assert.equal(locked.json().token, undefined);

    const elsewhere = await login('victim@example.com', 'correct-horse', '10.0.0.3');
    assert.equal(elsewhere.statusCode, 429);

    // 다른 계정은 영향 없음
    const other = await login('other@example.com', 'correct-horse', '10.0.0.2');
    assert.equal(other.statusCode, 200);
  });

  test('한 IP 에서 이메일을 바꿔 가며 20번 틀리면 그 IP 가 잠긴다', async () => {
    for (let i = 0; i < 20; i++) {
      const res = await login(`nobody${i}@example.com`, 'wrong-password', '10.0.0.9');
      assert.equal(res.statusCode, 401, `시도 ${i}`);
    }
    const locked = await login('other@example.com', 'correct-horse', '10.0.0.9');
    assert.equal(locked.statusCode, 429);
    // 다른 IP 는 영향 없음
    const fine = await login('other@example.com', 'correct-horse', '10.0.0.10');
    assert.equal(fine.statusCode, 200);
  });

  test('문자열이 아닌 email 은 500 이 아니라 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: { $ne: '' }, password: 'x' },
    });
    assert.equal(res.statusCode, 400);
  });
});

describe('gatehouse 계정 상태 확인 (계약 A)', () => {
  const me = (token: string) =>
    app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });

  /** 가짜 gatehouse: 이메일별 응답을 바꿔 끼운다. */
  let state: { status: number; body?: unknown } | Error = { status: 200, body: { active: true, revoked_before: null } };
  let calls = 0;
  let clock = Date.now();
  function installFake(): void {
    calls = 0;
    clock = Date.now();
    svc.setGatehouseStatus(
      gh.createGatehouseStatus({
        url: 'https://auth.example.test',
        secret: 'shared',
        now: () => clock,
        warn: () => {},
        fetch: async () => {
          calls++;
          if (state instanceof Error) throw state;
          const s = state;
          return { status: s.status, json: async () => s.body };
        },
      }),
    );
  }

  test('env 가 없으면(기본) SSO 토큰도 gatehouse 를 묻지 않고 통과', async () => {
    const res = await me(svc.signToken(admin, { sso: true }));
    assert.equal(res.statusCode, 200);
  });

  test('active → 200, 비활성화되면 캐시(60초)가 지난 뒤 401', async () => {
    state = { status: 200, body: { active: true, revoked_before: null } };
    installFake();
    const token = svc.signToken(admin, { sso: true });
    assert.equal((await me(token)).statusCode, 200);

    state = { status: 200, body: { active: false, revoked_before: null } };
    assert.equal((await me(token)).statusCode, 200, '캐시 안에서는 아직 통과');
    assert.equal(calls, 1);
    clock += 61_000;
    assert.equal((await me(token)).statusCode, 401);
    assert.equal(calls, 2);
  });

  test('404(gatehouse 가 모르는 이메일) → 401', async () => {
    state = { status: 404, body: { active: false } };
    installFake();
    assert.equal((await me(svc.signToken(admin, { sso: true }))).statusCode, 401);
  });

  test('revoked_before 가 토큰 발급 이후면 401, 이전이면 200', async () => {
    const token = svc.signToken(admin, { sso: true });
    state = { status: 200, body: { active: true, revoked_before: new Date(Date.now() + 60_000).toISOString() } };
    installFake();
    assert.equal((await me(token)).statusCode, 401);

    state = { status: 200, body: { active: true, revoked_before: new Date(Date.now() - 3600_000).toISOString() } };
    installFake();
    assert.equal((await me(token)).statusCode, 200);
  });

  test('비밀번호 로그인 토큰(로컬 계정)은 대상이 아니다', async () => {
    state = { status: 404, body: { active: false } };
    installFake();
    assert.equal((await me(svc.signToken(admin))).statusCode, 200);
    assert.equal(calls, 0);
  });

  test('gatehouse 장애: 성공한 적 없으면 통과', async () => {
    state = new Error('ECONNREFUSED');
    installFake();
    assert.equal((await me(svc.signToken(admin, { sso: true }))).statusCode, 200);
  });

  test('보호된 다른 API 도 같이 끊긴다 (전역 게이트 경유)', async () => {
    state = { status: 200, body: { active: false, revoked_before: null } };
    installFake();
    const res = await app.inject({
      method: 'GET',
      url: '/api/projects',
      headers: { authorization: `Bearer ${svc.signToken(admin, { sso: true })}` },
    });
    assert.equal(res.statusCode, 401);
    // 뒤 테스트에 영향이 없게 꺼 둔다
    svc.setGatehouseStatus(gh.createGatehouseStatus());
  });
});

describe('웹훅 URL 저장 검증', () => {
  const patch = (webhookUrl: string | null) =>
    app.inject({
      method: 'PATCH',
      url: `/api/projects/${projects.main}`,
      headers: { authorization: `Bearer ${svc.signToken(admin)}` },
      payload: { webhookUrl },
    });

  test('hooks.slack.com 이 아닌 URL 은 400', async () => {
    for (const bad of ['http://169.254.169.254/latest/meta-data/', 'https://evil.test/hook', 'http://hooks.slack.com/x']) {
      const res = await patch(bad);
      assert.equal(res.statusCode, 400, bad);
    }
  });

  test('슬랙 웹훅은 저장되고, null 로 지울 수 있다', async () => {
    const ok = await patch('https://hooks.slack.com/services/T000/B000/xxxx');
    assert.equal(ok.statusCode, 200, ok.body);
    assert.equal(ok.json().webhook_url, 'https://hooks.slack.com/services/T000/B000/xxxx');
    const cleared = await patch(null);
    assert.equal(cleared.statusCode, 200);
    assert.equal(cleared.json().webhook_url, null);
  });
});
