import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, setAuth, type CurrentUser } from '../api';

export default function SetupPage() {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    void api<{ needsSetup: boolean }>('/api/auth/status').then(({ needsSetup }) => {
      if (!needsSetup) navigate('/login', { replace: true });
    });
  }, [navigate]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const { token, user } = await api<{ token: string; user: CurrentUser }>('/api/auth/setup', {
        method: 'POST',
        body: JSON.stringify({ email, name, password }),
      });
      setAuth(token, user);
      navigate('/');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="panel login-box" onSubmit={submit}>
      <h1>
        look<span>out</span>
      </h1>
      <p className="dim" style={{ margin: 0, textAlign: 'center' }}>
        Welcome! Create the admin account for this instance.
      </p>
      <input
        placeholder="Name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        autoFocus
      />
      <input
        type="email"
        placeholder="Email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
      <input
        type="password"
        placeholder="Password (min 8 chars)"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      {error && <div className="error-text">{error}</div>}
      <button disabled={busy || !email || !name || password.length < 8}>
        Create admin account
      </button>
    </form>
  );
}
