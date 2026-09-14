import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createSession, validateSession, destroySession } from '../auth/session.js';
import { findOrCreateUser } from '../auth/users.repo.js';
import { query, pool } from '../db/pool.js';

after(async () => {
  await pool.end();
});

async function makeTestUser() {
  return findOrCreateUser({
    oktaId: `test-okta-session-${Date.now()}-${Math.random()}`,
    email: `session-${Date.now()}-${Math.random()}@example.com`,
    name: 'Session Test User',
    employeeId: 'E7000'
  });
}

test('createSession then validateSession returns the owning user', async () => {
  const user = await makeTestUser();
  const { token, expiresAt } = await createSession(user.id);

  assert.ok(token.length > 0);
  assert.ok(expiresAt.getTime() > Date.now());

  const validated = await validateSession(token);
  assert.deepEqual(validated, user);
});

test('validateSession returns null for an unknown token', async () => {
  const validated = await validateSession('this-token-does-not-exist');
  assert.equal(validated, null);
});

test('validateSession returns null for an expired session', async () => {
  const user = await makeTestUser();
  const { token } = await createSession(user.id);

  // Force the session to look expired.
  await query("UPDATE sessions SET expires_at = now() - interval '1 day' WHERE user_id = $1", [user.id]);

  const validated = await validateSession(token);
  assert.equal(validated, null);
});

test('destroySession removes the session so it no longer validates', async () => {
  const user = await makeTestUser();
  const { token } = await createSession(user.id);

  assert.notEqual(await validateSession(token), null);

  await destroySession(token);

  assert.equal(await validateSession(token), null);
});
