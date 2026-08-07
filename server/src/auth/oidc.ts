import * as oidc from 'openid-client';
import { config, baseUrl } from '../config.js';

/**
 * Optional OIDC SSO against an internal IdP (gatehouse). Enabled when
 * OIDC_ISSUER and OIDC_CLIENT_SECRET are set; password login keeps working.
 */

let provider: oidc.Configuration | null = null;

export function oidcEnabled(): boolean {
  return Boolean(config.oidcIssuer && config.oidcClientSecret);
}

export async function initOidc(): Promise<void> {
  if (!oidcEnabled()) return;
  provider = await oidc.discovery(
    new URL(config.oidcIssuer),
    config.oidcClientId,
    config.oidcClientSecret,
  );
}

export function redirectUri(): string {
  return `${baseUrl()}/api/auth/oidc/callback`;
}

export interface OidcStart {
  url: string;
  state: string;
  codeVerifier: string;
}

export async function buildAuthUrl(): Promise<OidcStart> {
  if (!provider) throw new Error('oidc not initialized');
  const codeVerifier = oidc.randomPKCECodeVerifier();
  const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
  const state = oidc.randomState();
  const url = oidc.buildAuthorizationUrl(provider, {
    redirect_uri: redirectUri(),
    scope: 'openid email profile',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
  });
  return { url: url.href, state, codeVerifier };
}

export interface OidcIdentity {
  email: string;
  name: string;
}

export async function handleCallback(
  currentUrl: URL,
  state: string,
  codeVerifier: string,
): Promise<OidcIdentity> {
  if (!provider) throw new Error('oidc not initialized');
  const tokens = await oidc.authorizationCodeGrant(provider, currentUrl, {
    pkceCodeVerifier: codeVerifier,
    expectedState: state,
  });
  const claims = tokens.claims();
  if (!claims?.email) throw new Error('no email claim in ID token');
  return {
    email: String(claims.email).toLowerCase(),
    name: String(claims.name ?? claims.email),
  };
}
