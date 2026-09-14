import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import type { Context, Next } from 'koa';
import { attachUser, requireAuth } from '../auth/auth.middleware.js';
import { createSession } from '../auth/session.js';
import { findOrCreateUser } from '../auth/users.repo.js';
import { pool } from '../db/pool.js';
import { HttpError } from '../middleware/error-handler.js';

after(async () => {
  await pool.end();
});

function fakeCtx(cookieValue: string | undefined): Context {
  return {
    cookies: { get: () => cookieValue },
    state: {}
  } as unknown as Context;
}

test('attachUser sets ctx.state.user from a valid session cookie', async () => {
  const user = await findOrCreateUser({
    oktaId: `test-okta-mw-${Date.now()}`,
    email: `mw-${Date.now()}@example.com`,
    name: 'Middleware Test User',
    employeeId: 'E8000'
  });
  const { token } = await createSession(user.id);

  const ctx = fakeCtx(token);
  let nextCalled = false;
  await attachUser(ctx, async () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
  assert.deepEqual(ctx.state.user, user);
});

test('attachUser sets ctx.state.user to null when there is no cookie', async () => {
  const ctx = fakeCtx(undefined);
  await attachUser(ctx, async () => {});
  assert.equal(ctx.state.user, null);
});

test('attachUser sets ctx.state.user to null for an invalid cookie', async () => {
  const ctx = fakeCtx('not-a-real-token');
  await attachUser(ctx, async () => {});
  assert.equal(ctx.state.user, null);
});

test('requireAuth calls next() when a user is present', async () => {
  const ctx = { state: { user: { id: 'u1' } } } as unknown as Context;
  let nextCalled = false;
  const next: Next = async () => {
    nextCalled = true;
  };
  await requireAuth(ctx, next);
  assert.equal(nextCalled, true);
});

test('requireAuth throws HttpError 401 when no user is present', async () => {
  const ctx = { state: { user: null } } as unknown as Context;
  await assert.rejects(
    () => requireAuth(ctx, async () => {}),
    (err: unknown) => err instanceof HttpError && err.status === 401
  );
});
