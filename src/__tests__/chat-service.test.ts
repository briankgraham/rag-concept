import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { answerChatMessage, type ChatDeps } from '../chat/chat.service.js';
import { getRecentMessages } from '../chat/conversation.repo.js';
import type { RagService } from '../rag/rag.service.js';
import type { PtoService } from '../hr/pto.service.js';
import { toolCallMessage, finalMessage, scriptedChat, fakePtoBalance } from './test-helpers.js';
import { findOrCreateUser } from '../auth/users.repo.js';
import { pool } from '../db/pool.js';
import { formatPtoAnswer } from '../hr/format.js';

after(async () => {
  await pool.end();
});

// answerChatMessage now persists conversation history for real (see
// src/chat/conversation.repo.ts), so it needs a real user row to satisfy
// conversation_messages' FK — a fresh one per test, same pattern as
// session.test.ts/chat-routes.test.ts, so each test starts with empty history.
async function makeTestUser() {
  return findOrCreateUser({
    oktaId: `test-okta-chatservice-${Date.now()}-${Math.random()}`,
    email: `chatservice-${Date.now()}-${Math.random()}@example.com`,
    name: 'Chat Service Test User',
    employeeId: 'E8000'
  });
}

function deps(chat: ReturnType<typeof scriptedChat>, ragService: Partial<RagService> = {}): ChatDeps {
  const ptoService: Partial<PtoService> = { getBalanceForEmployee: () => Promise.resolve(fakePtoBalance) };
  return {
    chat,
    ragService: ragService as RagService,
    ptoService: ptoService as PtoService,
    debug: false
  };
}

test('answerChatMessage labels a PTO-tool answer as pto_lookup', async () => {
  const user = await makeTestUser();
  const chat = scriptedChat([
    toolCallMessage('call_1', 'get_pto_balance', {}),
    finalMessage(formatPtoAnswer(fakePtoBalance))
  ]);

  const result = await answerChatMessage(deps(chat), user, 'how many pto days do i have left');
  assert.equal(result.source, 'pto_lookup');
});

test('answerChatMessage labels a docs-search answer as rag', async () => {
  const user = await makeTestUser();
  const chat = scriptedChat([
    toolCallMessage('call_1', 'search_company_docs', { queries: ['remote work'] }),
    finalMessage('Employees may work remotely up to 3 days a week.')
  ]);
  const ragService: Partial<RagService> = {
    searchDocs: () =>
      Promise.resolve({ context: '...', sourceCount: 1, sources: ['data/company-data/07_remote_work_policy.md'] })
  };

  const result = await answerChatMessage(
    deps(chat, ragService),
    user,
    'what is the remote work policy'
  );
  assert.equal(result.source, 'rag');
  // The source document search_company_docs matched flows all the way
  // through the orchestrator into the client-facing ChatAnswer, so a
  // caller can show a citation instead of just the coarse 'rag' label.
  assert.deepEqual(result.sources, ['data/company-data/07_remote_work_policy.md']);
});

test('answerChatMessage labels a no-tool answer as direct', async () => {
  const user = await makeTestUser();
  const chat = scriptedChat([finalMessage('Hi! How can I help?')]);

  const result = await answerChatMessage(deps(chat), user, 'hello');
  assert.equal(result.source, 'direct');
  assert.deepEqual(result.sources, []); // no search_company_docs call -> no citations
});

test('answerChatMessage labels a FAILED PTO lookup as pto_lookup, not direct', async () => {
  // Regression test: a get_pto_balance call that throws (e.g. a transient
  // DB error) must still be attributed to pto_lookup, since it was
  // genuinely a personal-data-lookup attempt — mislabeling it 'direct'
  // would make analytics/QA blind to failed personal-data paths.
  const user = await makeTestUser();
  const chat = scriptedChat([
    toolCallMessage('call_1', 'get_pto_balance', {}),
    finalMessage("Sorry, I couldn't look that up right now.")
  ]);
  const ptoService: Partial<PtoService> = {
    getBalanceForEmployee: () => Promise.reject(new Error('transient DB error'))
  };

  const result = await answerChatMessage(
    { chat, ragService: {} as RagService, ptoService: ptoService as PtoService, debug: false },
    user,
    'how many pto days do i have left'
  );
  assert.equal(result.source, 'pto_lookup');
});

test('answerChatMessage prefers pto_lookup over rag when both tools are called (personal data takes precedence)', async () => {
  const user = await makeTestUser();
  const chat = scriptedChat([
    {
      role: 'assistant' as const,
      content: null,
      toolCalls: [
        { id: 'c1', name: 'get_pto_balance', arguments: '{}' },
        { id: 'c2', name: 'search_company_docs', arguments: JSON.stringify({ queries: ['pto policy'] }) }
      ]
    },
    finalMessage('You have 10 days left, and the general policy is 20 days per year.')
  ]);
  const ragService: Partial<RagService> = {
    searchDocs: () =>
      Promise.resolve({ context: '...', sourceCount: 1, sources: ['data/company-data/01_company_handbook.md'] })
  };

  const result = await answerChatMessage(deps(chat, ragService), user, 'my pto and the policy');
  assert.equal(result.source, 'pto_lookup');
  // Source labeling prefers pto_lookup, but citations still surface both
  // tools' actual contributions — labeling and citation are separate
  // concerns.
  assert.deepEqual(result.sources, ['data/company-data/01_company_handbook.md']);
});

test('answerChatMessage persists the question and answer, and feeds prior turns back in as history', async () => {
  const user = await makeTestUser();

  const firstChat = scriptedChat([finalMessage('Can you tell me what you mean by allocation?')]);
  await answerChatMessage(deps(firstChat), user, 'company pto allocation');

  let capturedMessages: Array<{ role: string; content: unknown }> = [];
  const secondChat = scriptedChat([finalMessage('You get 20 days per year.')], (request) => {
    // Copy, not just reference — orchestrator.ts mutates this array in
    // place after the call returns.
    capturedMessages = [...(request as { messages: Array<{ role: string; content: unknown }> }).messages];
  });
  const result = await answerChatMessage(deps(secondChat), user, 'i mean my own balance');

  assert.equal(result.answer, 'You get 20 days per year.');
  // The second call's request to the LLM includes the first exchange as
  // history, ahead of the new follow-up question.
  assert.deepEqual(capturedMessages.slice(1, 3), [
    { role: 'user', content: 'company pto allocation' },
    { role: 'assistant', content: 'Can you tell me what you mean by allocation?' }
  ]);
  assert.deepEqual(capturedMessages[3], { role: 'user', content: 'i mean my own balance' });

  // And this second turn is itself persisted for the next call.
  const stored = await getRecentMessages(user.id);
  assert.deepEqual(
    stored.map((m) => m.content),
    [
      'company pto allocation',
      'Can you tell me what you mean by allocation?',
      'i mean my own balance',
      'You get 20 days per year.'
    ]
  );
});
