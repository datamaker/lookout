import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { query } from '../db/pool.js';
import {
  countUsers,
  hashPassword,
  publicUser,
  signOidcState,
  signToken,
  verifyOidcState,
  verifyPassword,
  verifyToken,
  type AuthUser,
} from '../auth/service.js';
import {
  buildAuthUrl,
  cliClientId,
  handleCallback,
  oidcEnabled,
  verifyCliIdToken,
  type OidcIdentity,
} from '../auth/oidc.js';
import { config } from '../config.js';
import { baseUrl } from '../config.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser | null;
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validCredentials(email?: string, password?: string, name?: string): string | null {
  if (!email || !EMAIL_RE.test(email)) return 'valid email is required';
  if (!password || password.length < 8) return 'password must be at least 8 characters';
  if (name !== undefined && !name.trim()) return 'name is required';
  return null;
}

export async function requireUser(req: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  req.user = token ? await verifyToken(token) : null;
  if (!req.user) {
    reply.code(401).send({ error: 'unauthorized' });
    return false;
  }
  return true;
}

export function requireAdmin(req: FastifyRequest, reply: FastifyReply): boolean {
  if (req.user?.role !== 'admin') {
    reply.code(403).send({ error: 'admin role required' });
    return false;
  }
  return true;
}

/**
 * JIT provisioning shared by the web callback and the CLI exchange: the IdP
 * already vouched for this workspace member. Password login stays possible
 * only via an admin-set password later.
 */
async function provisionSsoUser(identity: OidcIdentity): Promise<AuthUser> {
  let { rows } = await query<AuthUser>(
    `SELECT id, email, name, role, is_active FROM users WHERE email = $1`,
    [identity.email],
  );
  if (rows.length === 0) {
    const role = (await countUsers()) === 0 ? 'admin' : 'member';
    ({ rows } = await query<AuthUser>(
      `INSERT INTO users (email, name, password_hash, role)
       VALUES ($1, $2, $3, $4) RETURNING id, email, name, role, is_active`,
      [identity.email, identity.name, await hashPassword(randomBytes(24).toString('base64url')), role],
    ));
  }
  return rows[0];
}

export function registerAuthRoutes(app: FastifyInstance): void {
  app.decorateRequest('user', null);

  /** Public: does the instance need first-run setup? */
  app.get('/api/auth/status', async () => ({ needsSetup: (await countUsers()) === 0 }));

  /** First-run only: create the initial admin account. */
  app.post('/api/auth/setup', async (req, reply) => {
    if ((await countUsers()) > 0) {
      return reply.code(403).send({ error: 'setup already completed' });
    }
    const { email, name, password } = (req.body ?? {}) as {
      email?: string;
      name?: string;
      password?: string;
    };
    const invalid = validCredentials(email, password, name ?? '');
    if (invalid) return reply.code(400).send({ error: invalid });

    const { rows } = await query<AuthUser>(
      `INSERT INTO users (email, name, password_hash, role) VALUES ($1, $2, $3, 'admin')
       RETURNING id, email, name, role, is_active`,
      [email!.toLowerCase(), (name ?? '').trim() || email!, await hashPassword(password!)],
    );
    const user = rows[0];
    return reply.code(201).send({ token: signToken(user), user: publicUser(user) });
  });

  app.post('/api/auth/login', async (req, reply) => {
    const { email, password } = (req.body ?? {}) as { email?: string; password?: string };
    if (!email || !password) return reply.code(400).send({ error: 'email and password required' });

    const { rows } = await query<AuthUser & { password_hash: string }>(
      `SELECT id, email, name, role, is_active, password_hash FROM users WHERE email = $1`,
      [email.toLowerCase()],
    );
    const user = rows[0];
    if (!user || !user.is_active || !(await verifyPassword(password, user.password_hash))) {
      return reply.code(401).send({ error: 'invalid email or password' });
    }
    return { token: signToken(user), user: publicUser(user) };
  });

  /**
   * Public: is SSO configured? The login page shows the button; issuer +
   * cliClientId let the CLI run the device flow without local config.
   */
  app.get('/api/auth/oidc/status', async () => ({
    enabled: oidcEnabled(),
    ...(oidcEnabled() ? { issuer: config.oidcIssuer, cliClientId: cliClientId() } : {}),
  }));

  /**
   * CLI SSO: the CLI completed the device flow against the IdP and hands us
   * the id_token. Verify it (JWKS signature, issuer, CLI audience) and issue
   * a lookout JWT, JIT-provisioning the user like the web callback does.
   */
  app.post('/api/auth/oidc/exchange', async (req, reply) => {
    if (!oidcEnabled()) return reply.code(404).send({ error: 'sso not configured' });
    const { idToken } = (req.body ?? {}) as { idToken?: string };
    if (!idToken) return reply.code(400).send({ error: 'idToken is required' });

    let identity: OidcIdentity;
    try {
      identity = await verifyCliIdToken(idToken);
    } catch (err) {
      req.log.warn({ err }, 'cli sso exchange failed');
      return reply.code(403).send({ error: 'sso sign-in failed' });
    }

    const user = await provisionSsoUser(identity);
    if (!user.is_active) return reply.code(403).send({ error: 'account is deactivated' });
    return { token: signToken(user), user: publicUser(user) };
  });

  app.get('/api/auth/oidc/start', async (_req, reply) => {
    if (!oidcEnabled()) return reply.code(404).send({ error: 'sso not configured' });
    const { url, state, codeVerifier } = await buildAuthUrl();
    return reply
      .setCookie('lookout_oidc', signOidcState({ state, verifier: codeVerifier }), {
        path: '/api/auth/oidc',
        httpOnly: true,
        sameSite: 'lax',
        secure: baseUrl().startsWith('https://'),
        maxAge: 600,
      })
      .redirect(url);
  });

  app.get('/api/auth/oidc/callback', async (req, reply) => {
    if (!oidcEnabled()) return reply.code(404).send({ error: 'sso not configured' });
    const stored = req.cookies.lookout_oidc ? verifyOidcState(req.cookies.lookout_oidc) : null;
    reply.clearCookie('lookout_oidc', { path: '/api/auth/oidc' });
    if (!stored) return reply.code(400).send({ error: 'sso flow expired; start again' });

    let identity;
    try {
      identity = await handleCallback(new URL(req.url, baseUrl()), stored.state, stored.verifier);
    } catch (err) {
      req.log.warn({ err }, 'oidc callback failed');
      return reply.code(403).send({ error: 'sso sign-in failed' });
    }

    const user = await provisionSsoUser(identity);
    if (!user.is_active) return reply.code(403).send({ error: 'account is deactivated' });

    // The SPA login page picks the token out of the URL hash.
    return reply.redirect(`/login#sso=${signToken(user)}`);
  });

  app.get('/api/auth/me', async (req, reply) => {
    if (!(await requireUser(req, reply))) return reply;
    return { user: publicUser(req.user!) };
  });

  app.put('/api/auth/password', async (req, reply) => {
    if (!(await requireUser(req, reply))) return reply;
    const { current, next } = (req.body ?? {}) as { current?: string; next?: string };
    if (!next || next.length < 8) {
      return reply.code(400).send({ error: 'new password must be at least 8 characters' });
    }
    const { rows } = await query<{ password_hash: string }>(
      'SELECT password_hash FROM users WHERE id = $1',
      [req.user!.id],
    );
    if (!current || !(await verifyPassword(current, rows[0].password_hash))) {
      return reply.code(401).send({ error: 'current password is wrong' });
    }
    await query('UPDATE users SET password_hash = $2 WHERE id = $1', [
      req.user!.id,
      await hashPassword(next),
    ]);
    return { ok: true };
  });
}

export function registerUserRoutes(app: FastifyInstance): void {
  app.get('/api/users', async (req, reply) => {
    if (!(await requireUser(req, reply)) || !requireAdmin(req, reply)) return reply;
    const { rows } = await query(
      'SELECT id, email, name, role, is_active, created_at FROM users ORDER BY created_at',
    );
    return rows;
  });

  app.post('/api/users', async (req, reply) => {
    if (!(await requireUser(req, reply)) || !requireAdmin(req, reply)) return reply;
    const { email, name, password, role } = (req.body ?? {}) as {
      email?: string;
      name?: string;
      password?: string;
      role?: string;
    };
    const invalid = validCredentials(email, password, name);
    if (invalid) return reply.code(400).send({ error: invalid });
    const userRole = role === 'admin' ? 'admin' : 'member';

    try {
      const { rows } = await query(
        `INSERT INTO users (email, name, password_hash, role) VALUES ($1, $2, $3, $4)
         RETURNING id, email, name, role, is_active, created_at`,
        [email!.toLowerCase(), name!.trim(), await hashPassword(password!), userRole],
      );
      return reply.code(201).send(rows[0]);
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        return reply.code(409).send({ error: 'email already exists' });
      }
      throw err;
    }
  });

  app.patch('/api/users/:id', async (req, reply) => {
    if (!(await requireUser(req, reply)) || !requireAdmin(req, reply)) return reply;
    const id = parseInt((req.params as { id: string }).id, 10);
    const { role, isActive, password, name } = (req.body ?? {}) as {
      role?: string;
      isActive?: boolean;
      password?: string;
      name?: string;
    };

    // Guard against locking yourself (or everyone) out.
    if (id === req.user!.id && (role === 'member' || isActive === false)) {
      return reply.code(400).send({ error: 'cannot demote or deactivate yourself' });
    }
    if (password !== undefined && password.length < 8) {
      return reply.code(400).send({ error: 'password must be at least 8 characters' });
    }

    const { rows } = await query(
      `UPDATE users SET
         role = COALESCE($2, role),
         is_active = COALESCE($3, is_active),
         name = COALESCE($4, name),
         password_hash = COALESCE($5, password_hash)
       WHERE id = $1
       RETURNING id, email, name, role, is_active, created_at`,
      [
        id,
        role === 'admin' || role === 'member' ? role : null,
        isActive ?? null,
        name?.trim() || null,
        password ? await hashPassword(password) : null,
      ],
    );
    if (rows.length === 0) return reply.code(404).send({ error: 'not found' });
    return rows[0];
  });

  app.delete('/api/users/:id', async (req, reply) => {
    if (!(await requireUser(req, reply)) || !requireAdmin(req, reply)) return reply;
    const id = parseInt((req.params as { id: string }).id, 10);
    if (id === req.user!.id) {
      return reply.code(400).send({ error: 'cannot delete yourself' });
    }
    await query('DELETE FROM users WHERE id = $1', [id]);
    return reply.code(204).send();
  });
}
