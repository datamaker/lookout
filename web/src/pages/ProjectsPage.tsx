import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, isAdmin, type Project } from '../api';

export default function ProjectsPage() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();

  async function load() {
    setProjects(await api<Project[]>('/api/projects'));
  }

  useEffect(() => {
    void load();
  }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    try {
      const p = await api<Project>('/api/projects', {
        method: 'POST',
        body: JSON.stringify({ name }),
      });
      setName('');
      navigate(`/projects/${p.id}/settings`);
    } finally {
      setCreating(false);
    }
  }

  return (
    <>
      <h1 className="page-title">Projects</h1>
      {isAdmin() && (
        <form className="toolbar" onSubmit={create}>
          <input
            placeholder="New project name…"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <button disabled={creating || !name.trim()}>Create project</button>
        </form>
      )}
      <div className="panel">
        {projects === null ? (
          <div className="empty">Loading…</div>
        ) : projects.length === 0 ? (
          <div className="empty">No projects yet. Create one to get a DSN.</div>
        ) : (
          projects.map((p) => (
            <div
              key={p.id}
              className="row clickable"
              onClick={() => navigate(`/projects/${p.id}`)}
            >
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600 }}>{p.name}</div>
                <div className="dim mono">{p.slug}</div>
              </div>
              <div className="dim">{p.events_24h} events / 24h</div>
              <div>
                <span className="badge error">{p.unresolved_count} open</span>
              </div>
              <Link to={`/projects/${p.id}/settings`} onClick={(e) => e.stopPropagation()}>
                Settings
              </Link>
            </div>
          ))
        )}
      </div>
    </>
  );
}
