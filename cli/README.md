# @datasee/lookout-cli

CLI for [lookout](https://github.com/datamaker/lookout) — the self-hosted, Sentry-compatible error tracker. Browse and triage issues from the terminal, hand an error straight to Claude Code to fix, or run as an MCP server so AI agents can work with your errors directly.

```bash
npm install -g @datasee/lookout-cli
```

## Quick start

```bash
lookout login                 # SSO device flow when the server has OIDC, else email/password
lookout projects              # list projects with unresolved counts
lookout link my-project       # pin this repo to a project (.lookout.json)
lookout issues                # unresolved issues, newest activity first
lookout issue 42              # full detail with stack trace
lookout resolve 42            # triage: resolve / ignore / unresolve
```

`lookout login` signs in with the workspace SSO (OAuth 2.0 device flow — approve in the browser, no password typed into the terminal) whenever the server has OIDC configured; `--password` forces email/password login. Tokens are valid 7 days. Requires a public `lookout-cli` client (device-code grant) on the IdP and lookout server ≥ this version for `/api/auth/oidc/exchange`.

## AI integration

### `lookout fix` — one command from error to patch

```bash
lookout fix 42
```

Fetches issue #42 with its latest event (stack trace, breadcrumbs, request context), builds a repair prompt, and launches an interactive **Claude Code** session in the current repo. Claude finds the root cause, fixes the code, and marks the issue resolved (`lookout resolve 42`) when done — or you confirm at the end.

- `--print` — print the prompt only (pipe it anywhere)
- `--resolve` — auto-resolve after Claude exits cleanly
- `--model <m>` — pass a model through to `claude`

### `lookout mcp` — MCP server for Claude Code

```bash
lookout mcp install     # runs: claude mcp add --scope user lookout -- lookout mcp
```

Then Claude Code can call these tools in any conversation:

| Tool | Description |
| --- | --- |
| `list_projects` | Projects with unresolved counts and 24h volume |
| `list_issues` | Filter by project / status / search |
| `get_issue` | Full detail: stack trace, breadcrumbs, tags, request |
| `list_events` / `get_event` | Individual occurrences, raw Sentry payload |
| `update_issue_status` | resolve / ignore / unresolve |

So you can just say: *"lookout에서 unresolved 에러 확인하고 제일 많이 터진 것부터 고쳐줘"* — Claude lists the issues, reads the stack traces, fixes the code, and resolves them.

### Scripting / any other agent

Every read command takes `--json`:

```bash
lookout issues --json | jq '.issues[0]'
```

## Configuration

| Source | What |
| --- | --- |
| `~/.config/lookout/config.json` | server URL + token (written by `lookout login`, mode 0600) |
| `.lookout.json` (repo, found walking up from cwd) | default project — written by `lookout link` |
| `LOOKOUT_URL` / `LOOKOUT_TOKEN` / `LOOKOUT_PROJECT` | env overrides (CI, headless MCP) |

## License

MIT
