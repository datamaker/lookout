import { spawn } from 'node:child_process';

/**
 * OAuth 2.0 Device Authorization Grant (RFC 8628) against the lookout
 * server's IdP (gatehouse). The CLI is a public client: no secret, and the
 * resulting id_token is exchanged at the lookout backend for a lookout JWT.
 * Same flow as the vault CLI.
 */

interface DiscoveryDoc {
  device_authorization_endpoint?: string;
  token_endpoint: string;
}

export interface DeviceAuthorization {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval?: number;
}

const SCOPE = 'openid email profile';

export async function discover(issuer: string): Promise<DiscoveryDoc> {
  const res = await fetch(`${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`);
  if (!res.ok) throw new Error(`SSO discovery failed (HTTP ${res.status})`);
  const doc = (await res.json()) as DiscoveryDoc;
  if (!doc.device_authorization_endpoint) {
    throw new Error('IdP does not support the device flow (no device_authorization_endpoint)');
  }
  return doc;
}

export async function startDeviceAuthorization(
  discovery: DiscoveryDoc,
  clientId: string,
): Promise<DeviceAuthorization> {
  const res = await fetch(discovery.device_authorization_endpoint!, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, scope: SCOPE }),
  });
  if (!res.ok) throw new Error(`Device authorization failed (HTTP ${res.status})`);
  return (await res.json()) as DeviceAuthorization;
}

/** Polls the token endpoint until the user approves (or the flow fails). Resolves with the id_token. */
export async function pollForIdToken(
  discovery: DiscoveryDoc,
  clientId: string,
  auth: DeviceAuthorization,
): Promise<string> {
  let intervalMs = (auth.interval ?? 5) * 1000;
  const deadline = Date.now() + auth.expires_in * 1000;

  for (;;) {
    if (Date.now() > deadline) {
      throw new Error('Device login timed out. Run `lookout login` again.');
    }
    await sleep(intervalMs);

    const res = await fetch(discovery.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: auth.device_code,
        client_id: clientId,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      id_token?: string;
      error?: string;
      error_description?: string;
    };

    if (res.ok) {
      if (!body.id_token) throw new Error('IdP response missing id_token');
      return body.id_token;
    }

    switch (body.error) {
      case 'authorization_pending':
        continue;
      case 'slow_down':
        intervalMs += 5000;
        continue;
      case 'expired_token':
        throw new Error('Device code expired before approval. Run `lookout login` again.');
      case 'access_denied':
        throw new Error('Login was denied in the browser.');
      default:
        throw new Error(body.error_description || body.error || `Device login failed (HTTP ${res.status})`);
    }
  }
}

/** Best-effort browser open; failures are silently ignored (headless hosts). */
export function tryOpenBrowser(url: string): void {
  const [cmd, args]: [string, string[]] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => undefined);
    child.unref();
  } catch {
    // ignore — the user can open the printed URL manually
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
