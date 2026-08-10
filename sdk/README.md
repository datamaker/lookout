# @datasee/lookout

Tiny zero-dependency Node.js SDK for [lookout](https://github.com/datamaker/lookout), the self-hosted Sentry-compatible error tracker. It speaks the Sentry envelope protocol, so it works against any Sentry-compatible backend.

If your app already uses `@sentry/node`, you don't need this — just point your DSN at your lookout server. This package is for when you want error tracking without the full Sentry SDK (~0 deps vs ~20).

## Install

```bash
npm install @datasee/lookout
```

## Usage

```js
const lookout = require('@datasee/lookout'); // or: import * as lookout from '@datasee/lookout'

lookout.init({
  dsn: 'http://<public-key>@lookout.example.com:9000/1',
  environment: process.env.NODE_ENV,
  release: 'my-service@1.2.3',
});

// Uncaught exceptions and unhandled rejections are captured automatically.

try {
  doSomething();
} catch (err) {
  lookout.captureException(err);
}

lookout.captureMessage('Job finished with warnings', 'warning');

lookout.addBreadcrumb({ category: 'db', message: 'SELECT … executed' });
lookout.setTag('worker', 'crawler-3');
lookout.setUser({ id: 'user-42' });

// Express
app.use(lookout.expressErrorHandler());

// Before shutdown (queued events are sent asynchronously)
await lookout.flush(2000);
```

## Zero-code AWS Lambda instrumentation

No handler changes needed — set two environment variables (e.g. in `serverless.yml` `provider.environment`) and every function in the service reports errors:

```yaml
NODE_OPTIONS: -r @datasee/lookout/auto
LOOKOUT_DSN: https://<public-key>@lookout.example.com/<projectId>
```

The preload module wraps the handler referenced by `_HANDLER` before the Lambda runtime loads it: thrown errors are reported (with `functionName`, `awsRequestId`, EventBridge `source`/`detail-type`), flushed, and rethrown, so retry/DLQ semantics are preserved. It activates only when `LOOKOUT_DSN` is set and `NODE_ENV=production`; otherwise it is a no-op. CommonJS handlers only (`exports.handler = …`). Optional: `LOOKOUT_ENVIRONMENT` overrides the environment tag (falls back to `STAGE`, then `NODE_ENV`).

## Options

| Option | Default | Description |
| --- | --- | --- |
| `dsn` | *(required)* | `scheme://publicKey@host/projectId` |
| `environment` / `release` / `serverName` | — / — / `os.hostname()` | Attached to every event |
| `captureUnhandled` | `true` | Capture `uncaughtException` (then exit 1) and `unhandledRejection` |
| `maxBreadcrumbs` | `30` | Breadcrumb buffer size |
| `attachSourceContext` | `true` | Read source files to attach ±5 context lines to in-app frames |
| `beforeSend` | — | Mutate or drop (`return null`) events before sending |
| `debug` | `false` | Log transport errors to the console |

Requires Node 18+ (uses global `fetch`).

## License

MIT
