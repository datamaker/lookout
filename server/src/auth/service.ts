import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { query } from '../db/pool.js';

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

export function signToken(user: AuthUser): string {
  if (!jwtSecret) throw new Error('auth not initialized');
  return jwt.sign({ sub: String(user.id), email: user.email, role: user.role }, jwtSecret, {
    expiresIn: TOKEN_TTL,
  });
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
  return rows[0];
}

export async function countUsers(): Promise<number> {
  const { rows } = await query<{ count: string }>('SELECT COUNT(*) AS count FROM users');
  return parseInt(rows[0].count, 10);
}

export function publicUser(u: AuthUser): Omit<AuthUser, 'is_active'> & { is_active?: boolean } {
  return { id: u.id, email: u.email, name: u.name, role: u.role };
}
