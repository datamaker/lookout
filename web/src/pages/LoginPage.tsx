import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, setAuth, type CurrentUser } from '../api';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [ssoEnabled, setSsoEnabled] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    // SSO callback delivers the token in the URL hash.
    const match = window.location.hash.match(/^#sso=(.+)$/);
    if (match) {
      const token = match[1];
      window.history.replaceState(null, '', '/login');
      void fetch('/api/auth/me', { headers: { Authorization: `Bearer ${token}` } })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error('sso token rejected'))))
        .then(({ user }: { user: CurrentUser }) => {
          setAuth(token, user);
          navigate('/', { replace: true });
        })
        .catch(() => setError('SSO sign-in failed'));
      return;
    }
    void api<{ needsSetup: boolean }>('/api/auth/status').then(({ needsSetup }) => {
      if (needsSetup) navigate('/setup', { replace: true });
    });
    void api<{ enabled: boolean }>('/api/auth/oidc/status')
      .then(({ enabled }) => setSsoEnabled(enabled))
      .catch(() => {});
  }, [navigate]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const { token, user } = await api<{ token: string; user: CurrentUser }>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });
      setAuth(token, user);
      navigate('/');
    } catch {
      setError('Invalid email or password');
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
        type="email"
        placeholder="Email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        autoFocus
      />
      <input
        type="password"
        placeholder="Password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      {error && <div className="error-text">{error}</div>}
      <button disabled={busy || !email || !password}>Sign in</button>
      {ssoEnabled && (
        <button
          type="button"
          className="sso-button"
          onClick={() => {
            window.location.href = '/api/auth/oidc/start';
          }}
        >
          Datasee SSO로 로그인
        </button>
      )}
    </form>
  );
}
