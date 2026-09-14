import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { getRecentMessages, appendMessages, clearConversation } from '../chat/conversation.repo.js';
import { findOrCreateUser } from '../auth/users.repo.js';
import { pool } from '../db/pool.js';

after(async () => {
  await pool.end();
});

async function makeTestUser() {
  return findOrCreateUser({
    oktaId: `test-okta-convo-${Date.now()}-${Math.random()}`,
    email: `convo-${Date.now()}-${Math.random()}@example.com`,
    name: 'Conversation Test User',
    employeeId: 'E9000'
  });
}

test('getRecentMessages returns nothing for a user with no history', async () => {
  const user = await makeTestUser();
  assert.deepEqual(await getRecentMessages(user.id), []);
});

test('appendMessages stores turns in order and getRecentMessages replays them oldest-first', async () => {
  const user = await makeTestUser();

  await appendMessages(user.id, [
    { role: 'user', content: 'what is our pto policy' },
    { role: 'assistant', content: 'You get 20 days per year.' }
  ]);
  await appendMessages(user.id, [
    { role: 'user', content: 'does it carry over' },
    { role: 'assistant', content: 'Up to 5 days carry over into the next year.' }
  ]);

  assert.deepEqual(await getRecentMessages(user.id), [
    { role: 'user', content: 'what is our pto policy' },
    { role: 'assistant', content: 'You get 20 days per year.' },
    { role: 'user', content: 'does it carry over' },
    { role: 'assistant', content: 'Up to 5 days carry over into the next year.' }
  ]);
});

test('appendMessages does nothing when given an empty list', async () => {
  const user = await makeTestUser();
  await appendMessages(user.id, []);
  assert.deepEqual(await getRecentMessages(user.id), []);
});

test('appendMessages prunes older rows once a user exceeds config.maxConversationMessages', async () => {
  const user = await makeTestUser();

  // config.maxConversationMessages defaults to 20 — write 11 exchanges (22
  // rows) one at a time so pruning has to actually drop the oldest ones,
  // not just fail to grow past the cap on a single big insert.
  for (let i = 0; i < 11; i++) {
    await appendMessages(user.id, [
      { role: 'user', content: `question ${i}` },
      { role: 'assistant', content: `answer ${i}` }
    ]);
  }

  const stored = await getRecentMessages(user.id);
  assert.equal(stored.length, 20);
  // The oldest exchange (question 0/answer 0) was pruned; the newest
  // (question 10/answer 10) survived.
  assert.deepEqual(stored[0], { role: 'user', content: 'question 1' });
  assert.deepEqual(stored[stored.length - 1], { role: 'assistant', content: 'answer 10' });
});

test('clearConversation removes all of a user\'s history', async () => {
  const user = await makeTestUser();
  await appendMessages(user.id, [{ role: 'user', content: 'hello' }]);

  await clearConversation(user.id);

  assert.deepEqual(await getRecentMessages(user.id), []);
});

test('conversation history is scoped per user', async () => {
  const userA = await makeTestUser();
  const userB = await makeTestUser();

  await appendMessages(userA.id, [{ role: 'user', content: 'only for A' }]);

  assert.deepEqual(await getRecentMessages(userB.id), []);
  assert.deepEqual(await getRecentMessages(userA.id), [{ role: 'user', content: 'only for A' }]);
});
