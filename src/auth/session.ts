import crypto from 'crypto';
import { query } from '../db/pool.js';
import { config } from '../config.js';
import { getUserById, type User } from './users.repo.js';

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Create a new session for a user and return the raw token to set as a
 * cookie. Only the token's hash is stored in the DB, so a database read
 * alone can never be used to forge a valid session cookie.
 */
export async function createSession(userId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + config.sessionTtlMs);

  await query('INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, $3)', [
    userId,
    tokenHash,
    expiresAt
  ]);

  return { token, expiresAt };
}

/**
 * Validate a raw session token from a cookie. Returns the associated user
 * if the session exists and hasn't expired, otherwise null.
 */
export async function validateSession(token: string): Promise<User | null> {
  const tokenHash = hashToken(token);
  const result = await query<{ user_id: string; expires_at: Date }>(
    'SELECT user_id, expires_at FROM sessions WHERE token_hash = $1',
    [tokenHash]
  );

  if (result.rows.length === 0) return null;

  const { user_id, expires_at } = result.rows[0];
  if (new Date(expires_at).getTime() < Date.now()) return null;

  return getUserById(user_id);
}

export async function destroySession(token: string): Promise<void> {
  const tokenHash = hashToken(token);
  await query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash]);
}
