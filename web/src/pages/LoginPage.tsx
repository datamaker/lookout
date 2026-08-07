import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, setToken } from '../api';

export default function LoginPage() {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const { token } = await api<{ token: string }>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ password }),
      });
      setToken(token);
      navigate('/');
    } catch {
      setError('Wrong password');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="panel login-box" onSubmit={submit}>
      <h1>
        look<span>out</span>
      </h1>
      <input
        type="password"
        placeholder="Admin password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        autoFocus
      />
      {error && <div className="error-text">{error}</div>}
      <button disabled={busy || !password}>Sign in</button>
    </form>
  );
}
