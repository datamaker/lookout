import { useEffect, useState } from 'react';
import { api, getUser, type UserRow } from '../api';
import { timeAgo } from '../util';

export default function UsersPage() {
  const [users, setUsers] = useState<UserRow[] | null>(null);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'member' | 'admin'>('member');
  const [error, setError] = useState('');
  const me = getUser();

  async function load() {
    setUsers(await api<UserRow[]>('/api/users'));
  }

  useEffect(() => {
    void load();
  }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    try {
      await api('/api/users', {
        method: 'POST',
        body: JSON.stringify({ email, name, password, role }),
      });
      setEmail('');
      setName('');
      setPassword('');
      setRole('member');
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function patch(id: number, body: Record<string, unknown>) {
    setError('');
    try {
      await api(`/api/users/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function resetPassword(u: UserRow) {
    const next = prompt(`New password for ${u.email} (min 8 chars):`);
    if (next) await patch(u.id, { password: next });
  }

  async function remove(u: UserRow) {
    if (!confirm(`Delete user ${u.email}?`)) return;
    setError('');
    try {
      await api(`/api/users/${u.id}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <>
      <h1 className="page-title">Members</h1>

      <form className="toolbar" onSubmit={create}>
        <input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
        <input
          type="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <input
          type="password"
          placeholder="Password (min 8)"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <select value={role} onChange={(e) => setRole(e.target.value as 'member' | 'admin')}>
          <option value="member">member</option>
          <option value="admin">admin</option>
        </select>
        <button disabled={!email || !name || password.length < 8}>Add member</button>
      </form>
      {error && <div className="error-text" style={{ marginBottom: 12 }}>{error}</div>}

      <div className="panel">
        {users === null ? (
          <div className="empty">Loading…</div>
        ) : (
          users.map((u) => (
            <div key={u.id} className="row">
              <div className="grow">
                <div style={{ fontWeight: 600 }}>
                  {u.name} {u.id === me?.id && <span className="dim">(you)</span>}
                </div>
                <div className="dim wrap-anywhere">{u.email}</div>
              </div>
              <div className="row-actions user-meta">
                {!u.is_active && <span className="badge ignored">deactivated</span>}
                <span className={`badge ${u.role === 'admin' ? 'error' : 'info'}`}>{u.role}</span>
                <span className="dim">{timeAgo(u.created_at)}</span>
              </div>
              {u.id !== me?.id && (
                <div className="row-actions user-buttons">
                  <button
                    className="secondary"
                    onClick={() => patch(u.id, { role: u.role === 'admin' ? 'member' : 'admin' })}
                  >
                    Make {u.role === 'admin' ? 'member' : 'admin'}
                  </button>
                  <button
                    className="secondary"
                    onClick={() => patch(u.id, { isActive: !u.is_active })}
                  >
                    {u.is_active ? 'Deactivate' : 'Activate'}
                  </button>
                  <button className="secondary" onClick={() => resetPassword(u)}>
                    Reset password
                  </button>
                  <button className="danger" onClick={() => remove(u)}>
                    Delete
                  </button>
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </>
  );
}
