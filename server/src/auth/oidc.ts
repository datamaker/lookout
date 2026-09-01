import * as oidc from 'openid-client';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
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
  const issuerUrl = new URL(config.oidcIssuer);
  provider = await oidc.discovery(
    issuerUrl,
    config.oidcClientId,
    config.oidcClientSecret,
    undefined,
    // openid-client requires HTTPS; allow plain http for local development.
    issuerUrl.protocol === 'http:' ? { execute: [oidc.allowInsecureRequests] } : undefined,
  );
}

export function redirectUri(): string {
  return `${baseUrl()}/api/auth/oidc/callback`;
}

export function cliClientId(): string {
  return config.oidcCliClientId;
}

let jwks: JWTVerifyGetKey | null = null;

/**
 * Verifies an id_token obtained by the CLI's device flow: JWKS signature,
 * issuer, and the CLI client id as audience. Returns the verified identity.
 */
export async function verifyCliIdToken(idToken: string): Promise<OidcIdentity> {
  if (!provider) throw new Error('oidc not initialized');
  if (!jwks) {
    const jwksUri = provider.serverMetadata().jwks_uri;
    if (!jwksUri) throw new Error('IdP metadata has no jwks_uri');
    jwks = createRemoteJWKSet(new URL(jwksUri));
  }
  const { payload } = await jwtVerify(idToken, jwks, {
    issuer: provider.serverMetadata().issuer,
    audience: config.oidcCliClientId,
  });
  const email = String(payload.email ?? '').toLowerCase();
  if (!email || payload.email_verified !== true) {
    throw new Error('sso identity has no verified email');
  }
  return { email, name: String(payload.name ?? email) };
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
