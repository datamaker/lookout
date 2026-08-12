import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, type Issue, type StatsBucket } from '../api';
import { timeAgo } from '../util';

const STATUSES = ['unresolved', 'resolved', 'ignored'] as const;

function Chart({ buckets, hours }: { buckets: StatsBucket[]; hours: number }) {
  const bars = useMemo(() => {
    const byHour = new Map(buckets.map((b) => [new Date(b.bucket).getTime(), b.count]));
    const now = new Date();
    now.setMinutes(0, 0, 0);
    const out: number[] = [];
    for (let i = hours - 1; i >= 0; i--) {
      out.push(byHour.get(now.getTime() - i * 3600_000) ?? 0);
    }
    return out;
  }, [buckets, hours]);
  const max = Math.max(...bars, 1);
  return (
    <div className="chart" title="Events per hour, last 24h">
      {bars.map((count, i) => (
        <div
          key={i}
          className={`bar${count === 0 ? ' zero' : ''}`}
          style={{ height: `${Math.max((count / max) * 100, 4)}%` }}
          title={`${count} events`}
        />
      ))}
    </div>
  );
}

export default function IssuesPage() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const [status, setStatus] = useState<(typeof STATUSES)[number]>('unresolved');
  const [q, setQ] = useState('');
  const [issues, setIssues] = useState<Issue[] | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [stats, setStats] = useState<StatsBucket[]>([]);
  const [projectName, setProjectName] = useState('');

  useEffect(() => {
    void api<{ hours: number; buckets: StatsBucket[] }>(
      `/api/projects/${projectId}/stats?hours=24`,
    ).then((r) => setStats(r.buckets));
    void api<{ id: number; name: string }[]>('/api/projects').then((ps) => {
      const p = ps.find((p) => String(p.id) === projectId);
      if (p) setProjectName(p.name);
    });
  }, [projectId]);

  useEffect(() => {
    setIssues(null);
    const t = setTimeout(() => {
      void api<{ issues: Issue[]; counts: Record<string, number> }>(
        `/api/projects/${projectId}/issues?status=${status}&q=${encodeURIComponent(q)}`,
      ).then((r) => {
        setIssues(r.issues);
        setCounts(r.counts);
      });
    }, q ? 250 : 0);
    return () => clearTimeout(t);
  }, [projectId, status, q]);

  return (
    <>
      <div className="crumbs">
        <Link to="/">Projects</Link> <span className="dim">/</span> {projectName || `#${projectId}`}
      </div>
      <h1 className="page-title">
        Issues
        <span className="spacer" />
        <Link to={`/projects/${projectId}/settings`} className="dim title-link">
          Settings
        </Link>
      </h1>
      <div className="panel" style={{ marginBottom: 12 }}>
        <Chart buckets={stats} hours={24} />
      </div>
      <div className="tabs">
        {STATUSES.map((s) => (
          <button
            key={s}
            className={s === status ? 'active' : ''}
            onClick={() => setStatus(s)}
          >
            {s} {counts[s] ? `(${counts[s]})` : ''}
          </button>
        ))}
      </div>
      <div className="toolbar">
        <input
          type="search"
          placeholder="Search title or culprit…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      <div className="panel">
        {issues === null ? (
          <div className="empty">Loading…</div>
        ) : issues.length === 0 ? (
          <div className="empty">No {status} issues. 🎉</div>
        ) : (
          issues.map((issue) => (
            <div
              key={issue.id}
              className="row clickable"
              onClick={() => navigate(`/issues/${issue.id}`)}
            >
              <span className={`badge ${issue.level}`}>{issue.level}</span>
              <div className="grow">
                <div className="list-title">{issue.title}</div>
                <div className="dim mono wrap-anywhere">{issue.culprit ?? '—'}</div>
              </div>
              <div className="dim list-meta">
                <div>{issue.event_count} events</div>
                <div>{timeAgo(issue.last_seen)}</div>
              </div>
            </div>
          ))
        )}
      </div>
    </>
  );
}
