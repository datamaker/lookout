import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, type Project } from '../api';

export default function SettingsPage() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const [project, setProject] = useState<Project | null>(null);
  const [webhookUrl, setWebhookUrl] = useState('');
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void api<Project[]>('/api/projects').then((ps) => {
      const p = ps.find((p) => String(p.id) === projectId) ?? null;
      setProject(p);
      setWebhookUrl(p?.webhook_url ?? '');
    });
  }, [projectId]);

  async function save() {
    const updated = await api<Project>(`/api/projects/${projectId}`, {
      method: 'PATCH',
      body: JSON.stringify({ webhookUrl: webhookUrl.trim() || null }),
    });
    setProject(updated);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  async function remove() {
    if (!confirm(`Delete project "${project?.name}" and all of its issues/events?`)) return;
    await api(`/api/projects/${projectId}`, { method: 'DELETE' });
    navigate('/');
  }

  if (!project) return <div className="empty">Loading…</div>;

  const snippet = `const Sentry = require('@sentry/node');

Sentry.init({
  dsn: '${project.dsn}',
  environment: process.env.NODE_ENV,
});`;

  return (
    <>
      <div className="crumbs">
        <Link to="/">Projects</Link> <span className="dim">/</span>{' '}
        <Link to={`/projects/${project.id}`}>{project.name}</Link>{' '}
        <span className="dim">/</span> Settings
      </div>
      <h1 className="page-title">{project.name} settings</h1>

      <div className="section-title">DSN</div>
      <div className="panel dsn-box">
        <code>{project.dsn}</code>
        <button
          className="secondary"
          onClick={() => {
            void navigator.clipboard.writeText(project.dsn);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>

      <div className="section-title">@sentry/node setup</div>
      <div className="panel">
        <pre className="json">{snippet}</pre>
      </div>

      <div className="section-title">Webhook alerts</div>
      <div className="panel" style={{ padding: 16 }}>
        <p className="dim" style={{ marginTop: 0 }}>
          New issues and regressions are posted as Slack-compatible <code>{'{ text }'}</code>{' '}
          JSON. Works with Slack incoming webhooks and most chat tools.
        </p>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            style={{ flex: 1 }}
            placeholder="https://hooks.slack.com/services/…"
            value={webhookUrl}
            onChange={(e) => setWebhookUrl(e.target.value)}
          />
          <button onClick={save}>{saved ? 'Saved!' : 'Save'}</button>
        </div>
      </div>

      <div className="section-title">Danger zone</div>
      <div className="panel" style={{ padding: 16 }}>
        <button className="danger" onClick={remove}>
          Delete project
        </button>
      </div>
    </>
  );
}
