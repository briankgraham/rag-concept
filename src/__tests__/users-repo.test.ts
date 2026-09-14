import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { findOrCreateUser, getUserById } from '../auth/users.repo.js';
import { pool } from '../db/pool.js';
import type { OktaProfile } from '../auth/okta-client.interface.js';

after(async () => {
  await pool.end();
});

test('findOrCreateUser inserts a new user on first login', async () => {
  const profile: OktaProfile = {
    oktaId: `test-okta-${Date.now()}`,
    email: `test-${Date.now()}@example.com`,
    name: 'Test User',
    employeeId: 'E5000'
  };

  const user = await findOrCreateUser(profile);
  assert.equal(user.oktaId, profile.oktaId);
  assert.equal(user.email, profile.email);
  assert.equal(user.name, profile.name);
  assert.equal(user.employeeId, profile.employeeId);
  assert.ok(user.id);
});

test('findOrCreateUser updates name/email/employeeId on a repeat login with the same oktaId', async () => {
  const suffix = `${Date.now()}-${Math.random()}`;
  const oktaId = `test-okta-repeat-${suffix}`;
  const first = await findOrCreateUser({
    oktaId,
    email: `old-${suffix}@example.com`,
    name: 'Old Name',
    employeeId: 'E1'
  });

  const second = await findOrCreateUser({
    oktaId,
    email: `new-${suffix}@example.com`,
    name: 'New Name',
    employeeId: 'E2'
  });

  assert.equal(second.id, first.id); // same row, not a new one
  assert.equal(second.email, `new-${suffix}@example.com`);
  assert.equal(second.name, 'New Name');
  assert.equal(second.employeeId, 'E2');
});

test('getUserById returns the user when found', async () => {
  const created = await findOrCreateUser({
    oktaId: `test-okta-getbyid-${Date.now()}`,
    email: `getbyid-${Date.now()}@example.com`,
    name: 'Lookup Me',
    employeeId: 'E9'
  });

  const found = await getUserById(created.id);
  assert.deepEqual(found, created);
});

test('getUserById returns null when not found', async () => {
  const found = await getUserById('00000000-0000-0000-0000-000000000000');
  assert.equal(found, null);
});
