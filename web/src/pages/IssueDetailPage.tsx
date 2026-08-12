import React, { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, type EventSummary, type Issue } from '../api';
import { timeAgo } from '../util';

interface Frame {
  filename?: string;
  abs_path?: string;
  module?: string;
  function?: string;
  lineno?: number;
  colno?: number;
  in_app?: boolean;
  context_line?: string;
  pre_context?: string[];
  post_context?: string[];
}

interface ExceptionValue {
  type?: string;
  value?: string;
  stacktrace?: { frames?: Frame[] };
}

function StackTrace({ exception }: { exception: ExceptionValue }) {
  // Sentry sends frames oldest-first; display newest-first like sentry.io.
  const frames = [...(exception.stacktrace?.frames ?? [])].reverse();
  return (
    <div className="panel frames">
      {frames.map((f, i) => (
        <div key={i} className={`frame ${f.in_app !== false ? 'in-app' : 'not-in-app'}`}>
          <div>
            <span className="fn">{f.function ?? '<anonymous>'}</span>{' '}
            <span className="loc">
              {f.filename ?? f.module ?? f.abs_path ?? '?'}
              {f.lineno != null && `:${f.lineno}`}
              {f.colno != null && `:${f.colno}`}
            </span>
          </div>
          {f.context_line != null && (
            <div className="ctx">
              {(f.pre_context ?? []).map((line, j) => (
                <div key={`pre${j}`} className="line">{line || ' '}</div>
              ))}
              <div className="line current">{f.context_line}</div>
              {(f.post_context ?? []).map((line, j) => (
                <div key={`post${j}`} className="line">{line || ' '}</div>
              ))}
            </div>
          )}
        </div>
      ))}
      {frames.length === 0 && <div className="empty">No stack trace</div>}
    </div>
  );
}

interface Breadcrumb {
  timestamp?: number | string;
  category?: string;
  message?: string;
  level?: string;
  type?: string;
}

export default function IssueDetailPage() {
  const { issueId } = useParams();
  const [issue, setIssue] = useState<Issue | null>(null);
  const [events, setEvents] = useState<EventSummary[]>([]);
  const [showRaw, setShowRaw] = useState(false);

  async function load() {
    const i = await api<Issue>(`/api/issues/${issueId}`);
    setIssue(i);
    const e = await api<{ events: EventSummary[] }>(`/api/issues/${issueId}/events?limit=20`);
    setEvents(e.events);
  }

  useEffect(() => {
    void load();
  }, [issueId]);

  async function setStatus(status: string) {
    const updated = await api<Issue>(`/api/issues/${issueId}`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    });
    setIssue((prev) => (prev ? { ...prev, status: updated.status } : prev));
  }

  if (!issue) return <div className="empty">Loading…</div>;

  const payload = (issue.latest_event?.payload ?? {}) as {
    exception?: { values?: ExceptionValue[] };
    breadcrumbs?: { values?: Breadcrumb[] } | Breadcrumb[];
    tags?: Record<string, string>;
    request?: { url?: string; method?: string };
    user?: Record<string, unknown>;
    server_name?: string;
    contexts?: Record<string, Record<string, unknown>>;
  };
  const exceptions = payload.exception?.values ?? [];
  const primary = exceptions.length > 0 ? exceptions[exceptions.length - 1] : null;
  const breadcrumbs = Array.isArray(payload.breadcrumbs)
    ? payload.breadcrumbs
    : (payload.breadcrumbs?.values ?? []);

  return (
    <>
      <div className="crumbs">
        <Link to="/">Projects</Link> <span className="dim">/</span>{' '}
        <Link to={`/projects/${issue.project_id}`}>{issue.project_name}</Link>{' '}
        <span className="dim">/</span> Issue #{issue.id}
      </div>
      <h1 className="page-title" style={{ alignItems: 'flex-start' }}>
        <span className={`badge ${issue.level}`} style={{ marginTop: 6 }}>
          {issue.level}
        </span>
        <span style={{ flex: 1, wordBreak: 'break-word' }}>{issue.title}</span>
      </h1>
      <div className="toolbar">
        <div className="row-actions">
          <span className={`badge ${issue.status === 'unresolved' ? issue.level : issue.status}`}>
            {issue.status}
          </span>
          <span className="dim">
            {issue.event_count} events · first {timeAgo(issue.first_seen)} · last{' '}
            {timeAgo(issue.last_seen)}
          </span>
        </div>
        <span className="spacer" />
        <div className="row-actions">
          {issue.status !== 'resolved' && (
            <button onClick={() => setStatus('resolved')}>Resolve</button>
          )}
          {issue.status !== 'ignored' && (
            <button className="secondary" onClick={() => setStatus('ignored')}>
              Ignore
            </button>
          )}
          {issue.status !== 'unresolved' && (
            <button className="secondary" onClick={() => setStatus('unresolved')}>
              Reopen
            </button>
          )}
        </div>
      </div>

      {issue.culprit && (
        <div className="dim mono wrap-anywhere" style={{ marginBottom: 16 }}>
          {issue.culprit}
        </div>
      )}

      {primary && (
        <>
          <div className="section-title">Stack trace (latest event)</div>
          <StackTrace exception={primary} />
        </>
      )}

      {(payload.tags || payload.request || payload.user || payload.server_name) && (
        <>
          <div className="section-title">Context</div>
          <div className="panel">
            <dl className="kv">
              {issue.latest_event?.environment && (
                <>
                  <dt>environment</dt>
                  <dd>{issue.latest_event.environment}</dd>
                </>
              )}
              {issue.latest_event?.release && (
                <>
                  <dt>release</dt>
                  <dd>{issue.latest_event.release}</dd>
                </>
              )}
              {payload.server_name && (
                <>
                  <dt>server</dt>
                  <dd>{payload.server_name}</dd>
                </>
              )}
              {payload.request?.url && (
                <>
                  <dt>request</dt>
                  <dd>
                    {payload.request.method} {payload.request.url}
                  </dd>
                </>
              )}
              {payload.user && (
                <>
                  <dt>user</dt>
                  <dd className="mono">{JSON.stringify(payload.user)}</dd>
                </>
              )}
              {Object.entries(payload.tags ?? {}).map(([k, v]) => (
                <React.Fragment key={k}>
                  <dt>{k}</dt>
                  <dd>{String(v)}</dd>
                </React.Fragment>
              ))}
            </dl>
          </div>
        </>
      )}

      {breadcrumbs.length > 0 && (
        <>
          <div className="section-title">Breadcrumbs</div>
          <div className="panel">
            {breadcrumbs.slice(-20).map((b, i) => (
              <div key={i} className="row crumb-row">
                <span className="dim mono crumb-cat">{b.category ?? b.type ?? '—'}</span>
                <span className="grow crumb-msg">{b.message ?? ''}</span>
                {b.level && <span className={`badge ${b.level}`}>{b.level}</span>}
              </div>
            ))}
          </div>
        </>
      )}

      <div className="section-title">Recent events</div>
      <div className="panel">
        {events.map((e) => (
          <div key={e.id} className="row event-row">
            <span className="mono dim">{e.id.slice(0, 8)}</span>
            <span className="grow dim event-env">
              {e.environment ?? ''} {e.release ? `· ${e.release}` : ''}
            </span>
            <span className="dim event-time">{new Date(e.timestamp).toLocaleString()}</span>
          </div>
        ))}
      </div>

      <div className="section-title">
        <button className="secondary" onClick={() => setShowRaw(!showRaw)}>
          {showRaw ? 'Hide' : 'Show'} raw event JSON
        </button>
      </div>
      {showRaw && (
        <div className="panel">
          <pre className="json">{JSON.stringify(issue.latest_event?.payload, null, 2)}</pre>
        </div>
      )}
    </>
  );
}
