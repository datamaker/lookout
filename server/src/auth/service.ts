import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { query } from '../db/pool.js';
import { config } from '../config.js';
import { createGatehouseStatus, type GatehouseStatus } from './gatehouseStatus.js';

const TOKEN_TTL = '7d';
const BCRYPT_ROUNDS = 12;

export interface AuthUser {
  id: number;
  email: string;
  name: string;
  role: 'admin' | 'member';
  is_active: boolean;
}

let jwtSecret: string | null = null;

/** gatehouse 계정 상태 조회기. env 두 개가 다 있을 때만 실제로 묻는다. */
let gatehouse: GatehouseStatus = createGatehouseStatus({
  url: config.gatehouseStatusUrl,
  secret: config.gatehouseStatusSecret,
});

/** 테스트에서 가짜 조회기를 끼운다. */
export function setGatehouseStatus(next: GatehouseStatus): void {
  gatehouse = next;
}

/**
 * JWT signing secret: JWT_SECRET env if set, otherwise generated once and
 * persisted in the settings table so sessions survive restarts.
 */
export async function initAuth(): Promise<void> {
  if (process.env.JWT_SECRET) {
    jwtSecret = process.env.JWT_SECRET;
    return;
  }
  const existing = await query<{ value: string }>(
    `SELECT value FROM settings WHERE key = 'jwt_secret'`,
  );
  if (existing.rows.length > 0) {
    jwtSecret = existing.rows[0].value;
    return;
  }
  jwtSecret = randomBytes(32).toString('hex');
  await query(
    `INSERT INTO settings (key, value) VALUES ('jwt_secret', $1) ON CONFLICT (key) DO NOTHING`,
    [jwtSecret],
  );
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

/**
 * 세션 토큰 발급. SSO(gatehouse) 로그인으로 발급하는 토큰에는 sso: true 를 넣는다 —
 * 이 표시가 있는 토큰만 검증 때 gatehouse 에 계정 상태를 묻는다.
 * (비밀번호 로그인 토큰은 로컬 계정이므로 대상이 아니다.)
 */
export function signToken(user: AuthUser, opts: { sso?: boolean } = {}): string {
  if (!jwtSecret) throw new Error('auth not initialized');
  return jwt.sign(
    {
      sub: String(user.id),
      email: user.email,
      role: user.role,
      ...(opts.sso ? { sso: true } : {}),
    },
    jwtSecret,
    { expiresIn: TOKEN_TTL },
  );
}

export async function verifyToken(token: string): Promise<AuthUser | null> {
  if (!jwtSecret) return null;
  let payload: jwt.JwtPayload;
  try {
    payload = jwt.verify(token, jwtSecret) as jwt.JwtPayload;
  } catch {
    return null;
  }
  const { rows } = await query<AuthUser>(
    `SELECT id, email, name, role, is_active FROM users WHERE id = $1`,
    [parseInt(String(payload.sub), 10)],
  );
  if (rows.length === 0 || !rows[0].is_active) return null;

  // SSO 로 발급된 토큰이면 gatehouse 에 계정 상태를 확인한다 (60초 캐시).
  // 비활성화됐거나, 토큰 발급 뒤에 "세션 종료"가 눌렸으면 거절한다.
  if (payload.sso === true && gatehouse.enabled) {
    const issuedAtMs = typeof payload.iat === 'number' ? payload.iat * 1000 : null;
    const verdict = await gatehouse.check(rows[0].email, issuedAtMs);
    if (!verdict.ok) return null;
  }
  return rows[0];
}

/** Short-lived signed blob for the OIDC state/verifier round-trip cookie. */
export function signOidcState(payload: { state: string; verifier: string }): string {
  if (!jwtSecret) throw new Error('auth not initialized');
  return jwt.sign(payload, jwtSecret, { expiresIn: '10m' });
}

export function verifyOidcState(token: string): { state: string; verifier: string } | null {
  if (!jwtSecret) return null;
  try {
    const p = jwt.verify(token, jwtSecret) as jwt.JwtPayload;
    if (typeof p.state !== 'string' || typeof p.verifier !== 'string') return null;
    return { state: p.state, verifier: p.verifier };
  } catch {
    return null;
  }
}

export async function countUsers(): Promise<number> {
  const { rows } = await query<{ count: string }>('SELECT COUNT(*) AS count FROM users');
  return parseInt(rows[0].count, 10);
}

export function publicUser(u: AuthUser): Omit<AuthUser, 'is_active'> & { is_active?: boolean } {
  return { id: u.id, email: u.email, name: u.name, role: u.role };
}
