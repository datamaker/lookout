/**
 * DB 없이 도는 단위 테스트: 수집 크기 한도, 속도 제한 창, 로그인 시도 제한,
 * gatehouse 상태 조회(가짜 fetch), 슬랙 알림 이스케이프·URL 검증.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib';
import {
  decompressBody,
  jsonBytes,
  limitEventSize,
  PayloadTooLargeError,
  UnsupportedEncodingError,
} from '../src/ingest/limits.js';
import { createWindowLimiter } from '../src/ingest/rateLimit.js';
import { createLoginLimiter } from '../src/auth/loginLimiter.js';
import {
  createGatehouseStatus,
  type GatehouseFetch,
} from '../src/auth/gatehouseStatus.js';
import {
  buildAlertText,
  escapeSlackText,
  isAllowedWebhookUrl,
  sendIssueAlert,
  type WebhookFetch,
} from '../src/alerts/webhook.js';

const MB = 1024 * 1024;

describe('decompressBody — 압축 폭탄 방어', () => {
  const bomb = Buffer.alloc(50 * MB, 0); // 50 MB 의 0 → gzip 하면 수십 KB

  test('gzip 폭탄은 한도에서 끊긴다', () => {
    const gz = gzipSync(bomb);
    assert.ok(gz.length < 200 * 1024, `압축본이 작아야 한다 (${gz.length})`);
    assert.throws(() => decompressBody('gzip', gz, 2 * MB), PayloadTooLargeError);
  });

  test('deflate / brotli 폭탄도 끊긴다', () => {
    assert.throws(() => decompressBody('deflate', deflateSync(bomb), 2 * MB), PayloadTooLargeError);
    assert.throws(() => decompressBody('br', brotliCompressSync(bomb), 2 * MB), PayloadTooLargeError);
  });

  test('정상 크기는 그대로 풀린다 (gzip, deflate, br, 무압축)', () => {
    const body = Buffer.from(JSON.stringify({ message: 'hello' }));
    assert.deepEqual(decompressBody('gzip', gzipSync(body)), body);
    assert.deepEqual(decompressBody('deflate', deflateSync(body)), body);
    assert.deepEqual(decompressBody('br', brotliCompressSync(body)), body);
    assert.deepEqual(decompressBody(undefined, body), body);
  });

  test('무압축 본문도 한도를 넘으면 거절', () => {
    assert.throws(() => decompressBody(undefined, Buffer.alloc(3 * MB), 2 * MB), PayloadTooLargeError);
  });

  test('모르는 인코딩은 UnsupportedEncodingError', () => {
    assert.throws(() => decompressBody('compress', Buffer.from('x')), UnsupportedEncodingError);
  });

  test('깨진 gzip 은 크기 오류가 아닌 일반 오류', () => {
    assert.throws(
      () => decompressBody('gzip', Buffer.from('not gzip')),
      (err: unknown) => !(err instanceof PayloadTooLargeError),
    );
  });
});

describe('limitEventSize — 이벤트 한 건 크기', () => {
  const base = {
    event_id: 'a'.repeat(32),
    exception: {
      values: [
        {
          type: 'TypeError',
          value: 'boom',
          stacktrace: { frames: [{ filename: 'app.js', function: 'run', lineno: 3 }] },
        },
      ],
    },
  };

  test('한도 안이면 손대지 않는다', () => {
    const r = limitEventSize(base, MB);
    assert.equal(r.truncated, false);
    assert.equal(r.event, base);
  });

  test('큰 breadcrumbs·extra 는 잘라서 한도 안으로 넣고 예외 정보는 남긴다', () => {
    const event = {
      ...base,
      breadcrumbs: Array.from({ length: 3000 }, (_, i) => ({ message: `crumb ${i} ${'x'.repeat(400)}` })),
      extra: { dump: 'y'.repeat(600_000) },
    };
    assert.ok(jsonBytes(event) > MB);
    const r = limitEventSize(event, MB);
    assert.ok(r.event, '거절되면 안 된다');
    assert.equal(r.truncated, true);
    assert.ok(jsonBytes(r.event) <= MB);
    assert.equal(r.event.exception?.values?.[0].type, 'TypeError');
    assert.equal(r.event._lookout_truncated, true);
    const crumbs = r.event.breadcrumbs as { message: string }[];
    assert.equal(crumbs.length, 100);
    assert.ok(crumbs[99].message.startsWith('crumb 2999 '), '가장 최근 것을 남긴다');
    // 원본은 건드리지 않는다
    assert.equal(event.breadcrumbs.length, 3000);
  });

  test('스택 지역 변수(vars)가 큰 경우 떼어낸다', () => {
    const vars: Record<string, string> = {};
    for (let i = 0; i < 200; i++) vars[`v${i}`] = 'z'.repeat(8000);
    const event = {
      exception: {
        values: [{ type: 'E', value: 'v', stacktrace: { frames: [{ function: 'f', vars }] } }],
      },
    };
    const r = limitEventSize(event, MB);
    assert.ok(r.event);
    assert.ok(jsonBytes(r.event) <= MB);
    const frame = r.event.exception?.values?.[0].stacktrace?.frames?.[0] as Record<string, unknown>;
    assert.equal(frame.function, 'f');
    assert.equal(frame.vars, undefined);
  });

  test('줄여도 한도를 넘으면 null (거절)', () => {
    const tags: Record<string, string> = {};
    for (let i = 0; i < 200; i++) tags[`t${i}`] = 'q'.repeat(7000);
    const r = limitEventSize({ message: 'm', tags }, MB);
    assert.equal(r.event, null);
  });
});

describe('createWindowLimiter — 분당 바이트/건수 창', () => {
  test('한도까지 허용하고 넘으면 429 용 결과, 창이 지나면 풀린다', () => {
    let t = 1_000_000;
    const limiter = createWindowLimiter(1000, () => t);
    assert.equal(limiter.check('p1', 600).allowed, true);
    assert.equal(limiter.exhausted('p1').allowed, true);
    const denied = limiter.check('p1', 600);
    assert.equal(denied.allowed, false);
    assert.ok(denied.retryAfterSec >= 1 && denied.retryAfterSec <= 60);
    assert.equal(limiter.check('p1', 400).allowed, true);
    assert.equal(limiter.exhausted('p1').allowed, false);
    // 다른 프로젝트는 영향 없음
    assert.equal(limiter.check('p2', 1000).allowed, true);
    t += 60_001;
    assert.equal(limiter.exhausted('p1').allowed, true);
    assert.equal(limiter.check('p1', 1000).allowed, true);
  });

  test('limit 0 이면 꺼진다', () => {
    const limiter = createWindowLimiter(0);
    assert.equal(limiter.check('p', 1e12).allowed, true);
    assert.equal(limiter.exhausted('p').allowed, true);
  });
});

describe('createLoginLimiter — 로그인 무차별 대입 방어', () => {
  const MIN = 60_000;
  const make = (over: Partial<Parameters<typeof createLoginLimiter>[0]> = {}) => {
    const clock = { t: 5_000_000 };
    const limiter = createLoginLimiter({
      maxPerEmail: 3,
      maxPerIp: 6,
      lockoutMs: 15 * MIN,
      now: () => clock.t,
      ...over,
    });
    return { clock, limiter };
  };

  test('이메일당 한도만큼 실패하면 잠기고, 시간이 지나면 풀린다', () => {
    const { clock, limiter } = make();
    for (let i = 0; i < 3; i++) assert.equal(limiter.consume('1.1.1.1', 'A@x.com'), 0);
    const wait = limiter.consume('1.1.1.1', 'a@x.com'); // 대소문자 무시
    assert.ok(wait > 0 && wait <= 15 * 60);
    // 다른 IP 에서 같은 이메일도 잠겨 있다
    assert.ok(limiter.consume('2.2.2.2', 'a@x.com') > 0);
    // 다른 이메일은 영향 없음
    assert.equal(limiter.consume('2.2.2.2', 'b@x.com'), 0);
    clock.t += 15 * MIN + 1;
    assert.equal(limiter.consume('1.1.1.1', 'a@x.com'), 0);
  });

  test('IP 당 한도: 이메일을 바꿔 가며 시도해도 잠긴다', () => {
    const { limiter } = make();
    for (let i = 0; i < 6; i++) assert.equal(limiter.consume('9.9.9.9', `u${i}@x.com`), 0);
    assert.ok(limiter.consume('9.9.9.9', 'fresh@x.com') > 0);
    assert.equal(limiter.consume('8.8.8.8', 'fresh@x.com'), 0);
  });

  test('성공한 로그인은 IP 한도를 쓰지 않는다 (같은 IP 의 정상 사용자들)', () => {
    const { limiter } = make();
    for (let i = 0; i < 100; i++) {
      assert.equal(limiter.consume('1.1.1.1', `user${i}@x.com`), 0, `login ${i}`);
      limiter.success('1.1.1.1', `user${i}@x.com`);
    }
  });

  test('성공하면 그 이메일의 실패 기록이 지워진다', () => {
    const { limiter } = make({ maxPerIp: 0 });
    for (let round = 0; round < 10; round++) {
      assert.equal(limiter.consume('1.1.1.1', 'a@x.com'), 0);
      assert.equal(limiter.consume('1.1.1.1', 'a@x.com'), 0);
      assert.equal(limiter.consume('1.1.1.1', 'a@x.com'), 0, `round ${round}`);
      limiter.success('1.1.1.1', 'a@x.com');
    }
  });

  test('창 밖의 오래된 실패는 합쳐지지 않는다', () => {
    const { clock, limiter } = make();
    assert.equal(limiter.consume('1.1.1.1', 'a@x.com'), 0);
    assert.equal(limiter.consume('1.1.1.1', 'a@x.com'), 0);
    clock.t += 15 * MIN + 1;
    assert.equal(limiter.consume('1.1.1.1', 'a@x.com'), 0);
    assert.equal(limiter.consume('1.1.1.1', 'a@x.com'), 0);
    assert.equal(limiter.consume('1.1.1.1', 'a@x.com'), 0);
    assert.ok(limiter.consume('1.1.1.1', 'a@x.com') > 0);
  });

  test('한도 0 이면 꺼진다', () => {
    const { limiter } = make({ maxPerEmail: 0, maxPerIp: 0 });
    for (let i = 0; i < 100; i++) assert.equal(limiter.consume('1.1.1.1', 'a@x.com'), 0);
  });
});

describe('createGatehouseStatus — 계정 상태 조회 (계약 A)', () => {
  interface Call {
    url: string;
    secret: string;
    redirect: string;
  }
  function harness(responder: (email: string) => { status: number; body?: unknown } | Error) {
    const calls: Call[] = [];
    const warnings: string[] = [];
    const clock = { t: Date.parse('2026-11-13T04:00:00Z') };
    const fakeFetch: GatehouseFetch = async (url, init) => {
      calls.push({ url, secret: init.headers['X-Gatehouse-Secret'], redirect: init.redirect });
      const email = new URL(url).searchParams.get('email') ?? '';
      const r = responder(email);
      if (r instanceof Error) throw r;
      return { status: r.status, json: async () => r.body };
    };
    const status = createGatehouseStatus({
      url: 'https://auth.example.test/',
      secret: 's3cret',
      fetch: fakeFetch,
      now: () => clock.t,
      warn: (m) => warnings.push(m),
    });
    return { calls, warnings, clock, status };
  }
  const ISSUED = Date.parse('2026-11-13T02:00:00Z');

  test('URL·시크릿 중 하나라도 없으면 꺼져 있고 항상 통과 (fetch 도 안 부름)', async () => {
    let called = 0;
    const f: GatehouseFetch = async () => {
      called++;
      return { status: 404, json: async () => ({}) };
    };
    for (const opts of [{}, { url: 'https://a.test' }, { secret: 'x' }]) {
      const s = createGatehouseStatus({ ...opts, fetch: f });
      assert.equal(s.enabled, false);
      assert.deepEqual(await s.check('a@x.com', ISSUED), { ok: true });
    }
    assert.equal(called, 0);
  });

  test('요청 형식: 경로·이메일 인코딩·시크릿 헤더·리다이렉트 금지', async () => {
    const h = harness(() => ({ status: 200, body: { active: true, revoked_before: null } }));
    assert.deepEqual(await h.status.check('A+b@Datasee.co.kr', ISSUED), { ok: true });
    assert.equal(h.calls.length, 1);
    assert.equal(
      h.calls[0].url,
      'https://auth.example.test/internal/account?email=a%2Bb%40datasee.co.kr',
    );
    assert.equal(h.calls[0].secret, 's3cret');
    assert.equal(h.calls[0].redirect, 'error');
  });

  test('active:false → 거절', async () => {
    const h = harness(() => ({ status: 200, body: { active: false, revoked_before: null } }));
    assert.deepEqual(await h.status.check('a@x.com', ISSUED), { ok: false, reason: 'inactive' });
  });

  test('404(모르는 이메일) → 비활성 취급', async () => {
    const h = harness(() => ({ status: 404, body: { active: false } }));
    assert.deepEqual(await h.status.check('a@x.com', ISSUED), { ok: false, reason: 'inactive' });
  });

  test('revoked_before 보다 먼저 발급된 토큰은 거절, 이후 발급은 통과', async () => {
    const h = harness(() => ({
      status: 200,
      body: { active: true, revoked_before: '2026-11-13T03:00:00.000Z' },
    }));
    assert.deepEqual(await h.status.check('a@x.com', ISSUED), { ok: false, reason: 'revoked' });
    assert.deepEqual(
      await h.status.check('a@x.com', Date.parse('2026-11-13T03:00:01Z')),
      { ok: true },
    );
  });

  test('60초 캐시: 그 안에는 다시 묻지 않고, 지나면 다시 묻는다', async () => {
    let active = true;
    const h = harness(() => ({ status: 200, body: { active, revoked_before: null } }));
    assert.equal((await h.status.check('a@x.com', ISSUED)).ok, true);
    active = false;
    h.clock.t += 59_000;
    assert.equal((await h.status.check('a@x.com', ISSUED)).ok, true);
    assert.equal(h.calls.length, 1);
    h.clock.t += 2_000;
    assert.equal((await h.status.check('a@x.com', ISSUED)).ok, false);
    assert.equal(h.calls.length, 2);
  });

  test('한 번도 성공한 적 없이 장애(네트워크 오류·5xx·401)면 통과', async () => {
    for (const failure of [new Error('ECONNREFUSED'), { status: 503 }, { status: 401 }]) {
      const h = harness(() => failure);
      assert.deepEqual(await h.status.check('a@x.com', ISSUED), { ok: true });
      assert.equal(h.warnings.length, 1);
    }
  });

  test('장애 중에는 마지막으로 성공한 결과를 쓴다 (비활성은 계속 거절)', async () => {
    let down = false;
    const h = harness(() =>
      down ? new Error('timeout') : { status: 200, body: { active: false, revoked_before: null } },
    );
    assert.equal((await h.status.check('a@x.com', ISSUED)).ok, false);
    down = true;
    h.clock.t += 61_000;
    assert.deepEqual(await h.status.check('a@x.com', ISSUED), { ok: false, reason: 'inactive' });
    // 다른(처음 보는) 이메일은 통과
    assert.deepEqual(await h.status.check('new@x.com', ISSUED), { ok: true });
  });

  test('경고 로그는 분당 1줄', async () => {
    const h = harness(() => new Error('down'));
    for (let i = 0; i < 5; i++) await h.status.check(`u${i}@x.com`, ISSUED);
    assert.equal(h.warnings.length, 1);
    h.clock.t += 61_000;
    await h.status.check('later@x.com', ISSUED);
    assert.equal(h.warnings.length, 2);
  });

  test('실패 직후에는 잠깐 다시 묻지 않는다 (요청마다 타임아웃을 기다리지 않게)', async () => {
    const h = harness(() => new Error('down'));
    await h.status.check('a@x.com', ISSUED);
    await h.status.check('a@x.com', ISSUED);
    assert.equal(h.calls.length, 1);
    h.clock.t += 11_000;
    await h.status.check('a@x.com', ISSUED);
    assert.equal(h.calls.length, 2);
  });

  test('동시 요청은 조회 한 번을 공유한다', async () => {
    const h = harness(() => ({ status: 200, body: { active: true, revoked_before: null } }));
    await Promise.all(Array.from({ length: 10 }, () => h.status.check('a@x.com', ISSUED)));
    assert.equal(h.calls.length, 1);
  });
});

describe('슬랙 알림 — 이스케이프와 웹훅 URL 검증', () => {
  test('& < > 이스케이프, 줄바꿈 접기', () => {
    assert.equal(
      escapeSlackText('<!channel> a & b\n<https://evil.test|공지>'),
      '&lt;!channel&gt; a &amp; b &lt;https://evil.test|공지&gt;',
    );
  });

  test('알림 본문에 이벤트 값이 그대로 들어가지 않는다', () => {
    const text = buildAlertText(
      { name: 'Demo <b>' },
      {
        issueId: 7,
        title: 'Error: <!here> click <https://evil.test|here>\nfake line',
        culprit: 'run (<script>)',
        level: 'error>',
        environment: 'prod & <x>',
        kind: 'new',
      },
    );
    assert.ok(!/[<>]/.test(text), text);
    assert.ok(text.includes('&lt;!here&gt;'));
    assert.ok(text.includes('prod &amp; &lt;x&gt;'));
    assert.equal(text.split('\n').length, 4, '제목의 줄바꿈으로 줄이 늘어나면 안 된다');
    assert.ok(text.endsWith('/issues/7'));
  });

  test('허용 URL: 기본은 https://hooks.slack.com 만', () => {
    assert.equal(isAllowedWebhookUrl('https://hooks.slack.com/services/T/B/x', []), true);
    for (const bad of [
      'http://hooks.slack.com/services/T/B/x',
      'https://hooks.slack.com.evil.test/x',
      'https://evil.test/hooks.slack.com',
      'https://user:pw@hooks.slack.com/x',
      'http://169.254.169.254/latest/meta-data/',
      'http://127.0.0.1:9600/internal',
      'file:///etc/passwd',
      'not a url',
    ]) {
      assert.equal(isAllowedWebhookUrl(bad, []), false, bad);
    }
  });

  test('env 로 호스트를 추가하면 그 호스트(https)만 더 허용, * 는 전부', () => {
    assert.equal(isAllowedWebhookUrl('https://discord.com/api/webhooks/1/x/slack', ['discord.com']), true);
    assert.equal(isAllowedWebhookUrl('http://discord.com/api/webhooks/1', ['discord.com']), false);
    assert.equal(isAllowedWebhookUrl('https://other.test/x', ['discord.com']), false);
    assert.equal(isAllowedWebhookUrl('http://localhost:3000/hook', ['*']), true);
    assert.equal(isAllowedWebhookUrl('file:///etc/passwd', ['*']), false);
  });

  const project = (webhook_url: string) => ({
    id: 1,
    slug: 'demo',
    name: 'Demo',
    public_key: 'k',
    webhook_url,
  });
  const alert = { issueId: 1, title: '<!channel>', culprit: null, level: 'error', environment: null, kind: 'new' as const };

  test('허용되지 않은 URL 로는 요청을 보내지 않는다', async () => {
    let called = 0;
    const f: WebhookFetch = async () => {
      called++;
      return { ok: true, status: 200 };
    };
    await sendIssueAlert(project('http://169.254.169.254/latest/meta-data/'), alert, f);
    await sendIssueAlert(project('https://evil.test/hook'), alert, f);
    assert.equal(called, 0);
  });

  test('허용된 URL 로는 이스케이프된 본문을, 리다이렉트를 따라가지 않게 보낸다', async () => {
    const seen: { url: string; redirect: string; body: string }[] = [];
    const f: WebhookFetch = async (url, init) => {
      seen.push({ url, redirect: init.redirect, body: init.body });
      return { ok: false, status: 302 };
    };
    await sendIssueAlert(project('https://hooks.slack.com/services/T/B/x'), alert, f);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].redirect, 'manual');
    const text = (JSON.parse(seen[0].body) as { text: string }).text;
    assert.ok(text.includes('&lt;!channel&gt;'));
    assert.ok(!text.includes('<!channel>'));
  });
});
