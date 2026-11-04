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

  // Auto-start SSO so a gatehouse session carries straight in (same feel as the
  // forward-auth apps). `?local=1` shows the password form instead — used by
  // Log out and as the break-glass path. A one-shot flag stops a bounce loop
  // when the IdP sends us back without a token.
  const AUTO_FLAG = 'lookout_sso_auto';

  useEffect(() => {
    // SSO callback delivers the token in the URL hash.
    const match = window.location.hash.match(/^#sso=(.+)$/);
    if (match) {
      const token = match[1];
      sessionStorage.removeItem(AUTO_FLAG);
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
    const local = new URLSearchParams(window.location.search).get('local') === '1';
    const bounced = Number(sessionStorage.getItem(AUTO_FLAG) ?? 0) > Date.now() - 60_000;
    void (async () => {
      const { needsSetup } = await api<{ needsSetup: boolean }>('/api/auth/status');
      if (needsSetup) {
        navigate('/setup', { replace: true });
        return;
      }
      const { enabled } = await api<{ enabled: boolean }>('/api/auth/oidc/status').catch(
        () => ({ enabled: false }),
      );
      setSsoEnabled(enabled);
      if (enabled && !local && !bounced) {
        sessionStorage.setItem(AUTO_FLAG, String(Date.now()));
        window.location.replace('/api/auth/oidc/start');
      }
    })();
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
