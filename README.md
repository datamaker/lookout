# lookout

Self-hosted, Sentry-compatible error tracking — small enough to read in an afternoon.

Your services already use `@sentry/node`? **Change one line (the DSN) and errors flow into your own server.** No SDK to swap, no vendor account, no per-seat pricing.

- **Sentry SDK compatible** — speaks the Sentry envelope protocol (`/api/<project>/envelope/`) and the legacy store endpoint. Tested with `@sentry/node` v7.
- **Issue grouping** — events are fingerprinted by exception type + stack frames (line-number agnostic, so redeploys don't split issues) and grouped into issues with first/last seen and counts.
- **Web dashboard** — issue list with search and status tabs, stack trace viewer with source context, breadcrumbs, tags, event history, 24h frequency chart.
- **Webhook alerts** — new issues and regressions post Slack-compatible JSON to a per-project webhook.
- **Boring stack** — Node + Fastify + PostgreSQL. One container plus Postgres.

## Quick start

```bash
git clone https://github.com/datamaker/lookout.git
cd lookout
LOOKOUT_ADMIN_PASSWORD=change-me docker compose up -d --build
```

Open http://localhost:9000, sign in with the admin password, create a project, and copy its DSN into your app:

```js
const Sentry = require('@sentry/node');

Sentry.init({
  dsn: 'http://<public-key>@localhost:9000/1', // from the project settings page
  environment: process.env.NODE_ENV,
});
```

That's it — `Sentry.captureException(err)` and unhandled errors now land in lookout.

## No Sentry SDK? Use @datasee/lookout

If you'd rather not pull in the full Sentry SDK, [`@datasee/lookout`](https://www.npmjs.com/package/@datasee/lookout) is a zero-dependency client (~6 kB) that lives in [`sdk/`](sdk/):

```bash
npm install @datasee/lookout
```

```js
const lookout = require('@datasee/lookout');
lookout.init({ dsn: 'http://<public-key>@localhost:9000/1' });
lookout.captureException(new Error('boom'));
```

Uncaught exceptions and unhandled rejections are captured automatically; breadcrumbs, tags, user context, source context lines, and an Express error handler are included. See [sdk/README.md](sdk/README.md).

## Configuration

| Env var | Default | Description |
| --- | --- | --- |
| `PORT` | `9000` | HTTP port |
| `DATABASE_URL` | `postgres://lookout:lookout@localhost:5434/lookout` | PostgreSQL connection string |
| `LOOKOUT_ADMIN_PASSWORD` | `lookout` | Dashboard password. **Set this.** |
| `LOOKOUT_PUBLIC_URL` | *(empty)* | Public base URL, used for DSNs shown in the UI and links in alerts, e.g. `https://lookout.example.com` |
| `LOOKOUT_RETENTION_DAYS` | `90` | Raw events older than this are deleted hourly. Issues are kept. |

## What it accepts

| Endpoint | Behavior |
| --- | --- |
| `POST /api/<project>/envelope/` | Sentry envelope (gzip/deflate ok). `event` items are stored; transactions, sessions, and client reports are accepted and dropped. |
| `POST /api/<project>/store/` | Legacy single-event JSON. |

Authentication uses the DSN public key (`X-Sentry-Auth` header or `sentry_key` query param), so any Sentry SDK that can target a custom DSN should work — `@sentry/node`, `@sentry/browser`, sentry-python, etc. Only v7-style error events are officially tested.

## Development

```bash
npm install
docker compose -f docker-compose.dev.yml up -d   # postgres on :5434
npm run dev        # API server on :9000 (runs migrations on boot)
npm run dev:web    # Vite dev server on :5180, proxies /api
```

`npm run build` builds the dashboard into `web/dist` and the server into `server/dist`; the server serves the dashboard statically when `web/dist` exists.

## Design notes

- **Grouping**: default fingerprint is `sha256(exception type + (module:function) of up to 8 innermost in-app frames)`. Custom `fingerprint` arrays on the event are respected, including `{{ default }}`.
- **Regressions**: an event arriving for a `resolved` issue reopens it and fires the webhook again.
- **Auth model**: single admin password for the dashboard; ingestion is authenticated per-project by DSN key. This is deliberately simple — put it behind your VPN or add a reverse-proxy auth layer if you need more.

## Non-goals (for now)

Performance tracing, session replay, source map processing, multi-user/teams, SSO. If you need those, use [Sentry](https://sentry.io) — this project exists for the "I just want error tracking on my own box" case.

## License

MIT © JungBin Kwon
