import type { Context, Next } from 'koa';
import { config } from '../config.js';
import { validateSession } from './session.js';
import { HttpError } from '../middleware/error-handler.js';
import type { User } from './users.repo.js';

declare module 'koa' {
  interface DefaultState {
    user: User | null;
  }
}

/**
 * Populates ctx.state.user from the session cookie, if present and valid.
 * Never rejects the request itself — use requireAuth for that.
 */
export async function attachUser(ctx: Context, next: Next): Promise<void> {
  const token = ctx.cookies.get(config.sessionCookieName);
  ctx.state.user = token ? await validateSession(token) : null;
  await next();
}

export async function requireAuth(ctx: Context, next: Next): Promise<void> {
  if (!ctx.state.user) {
    throw new HttpError(401, 'unauthenticated', 'Login required');
  }
  await next();
}
