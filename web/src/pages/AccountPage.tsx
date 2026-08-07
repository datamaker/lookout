import { useState } from 'react';
import { api, getUser } from '../api';

export default function AccountPage() {
  const me = getUser();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (next !== confirm) {
      setError('New passwords do not match');
      return;
    }
    setBusy(true);
    try {
      await api('/api/auth/password', {
        method: 'PUT',
        body: JSON.stringify({ current, next }),
      });
      setCurrent('');
      setNext('');
      setConfirm('');
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1 className="page-title">Account</h1>

      <div className="section-title">Profile</div>
      <div className="panel">
        <dl className="kv">
          <dt>name</dt>
          <dd>{me?.name}</dd>
          <dt>email</dt>
          <dd>{me?.email}</dd>
          <dt>role</dt>
          <dd>
            <span className={`badge ${me?.role === 'admin' ? 'error' : 'info'}`}>{me?.role}</span>
          </dd>
        </dl>
      </div>

      <div className="section-title">Change password</div>
      <form className="panel" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 420 }} onSubmit={submit}>
        <input
          type="password"
          placeholder="Current password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          autoComplete="current-password"
        />
        <input
          type="password"
          placeholder="New password (min 8 chars)"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          autoComplete="new-password"
        />
        <input
          type="password"
          placeholder="Confirm new password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          autoComplete="new-password"
        />
        {error && <div className="error-text">{error}</div>}
        <button disabled={busy || !current || next.length < 8 || !confirm}>
          {saved ? 'Password changed!' : 'Change password'}
        </button>
      </form>
    </>
  );
}
