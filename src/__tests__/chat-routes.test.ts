import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import Koa from 'koa';
import bodyParser from 'koa-bodyparser';
import type { Server } from 'http';
import { createChatRouter } from '../chat/chat.routes.js';
import type { ChatDeps } from '../chat/chat.service.js';
import { getRecentMessages } from '../chat/conversation.repo.js';
import { attachUser } from '../auth/auth.middleware.js';
import { createSession } from '../auth/session.js';
import { findOrCreateUser } from '../auth/users.repo.js';
import { pool } from '../db/pool.js';
import { errorHandler } from '../middleware/error-handler.js';
import type { RagService } from '../rag/rag.service.js';
import type { PtoService } from '../hr/pto.service.js';
import { scriptedOpenAI, toolCallMessage, finalMessage, fakePtoBalance } from './test-helpers.js';

after(async () => {
  await pool.end();
});

async function withServer(
  deps: ChatDeps,
  fn: (baseUrl: string, cookie: string, userId: string) => Promise<void>
) {
  const user = await findOrCreateUser({
    oktaId: `test-okta-chatroute-${Date.now()}-${Math.random()}`,
    email: `chatroute-${Date.now()}-${Math.random()}@example.com`,
    name: 'Chat Route Test User',
    employeeId: 'E6000'
  });
  const { token } = await createSession(user.id);

  const app = new Koa();
  app.use(errorHandler);
  app.use(bodyParser());
  app.use(attachUser);
  app.use(createChatRouter(deps).routes());

  const server: Server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('failed to bind');

  try {
    await fn(`http://127.0.0.1:${address.port}`, `session_token=${token}`, user.id);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function testDeps(openai = scriptedOpenAI([finalMessage('hi')])): ChatDeps {
  const ragService: Partial<RagService> = {};
  const ptoService: Partial<PtoService> = {};
  return {
    openai,
    ragService: ragService as RagService,
    ptoService: ptoService as PtoService,
    debug: false
  };
}

test('POST /api/chat returns an answer for an authenticated user', async () => {
  const openai = scriptedOpenAI([
    toolCallMessage('call_1', 'get_pto_balance', {}),
    finalMessage('You have 10 days left.')
  ]);
  const ptoService: Partial<PtoService> = { getBalanceForEmployee: () => Promise.resolve(fakePtoBalance) };
  const deps: ChatDeps = { ...testDeps(openai), ptoService: ptoService as PtoService };

  await withServer(deps, async (baseUrl, cookie) => {
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ question: 'how many pto days do i have left' })
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { answer: string; source: string };
    assert.equal(body.answer, 'You have 10 days left.');
    assert.equal(body.source, 'pto_lookup');
  });
});

test('POST /api/chat without a question returns 400', async () => {
  await withServer(testDeps(), async (baseUrl, cookie) => {
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({})
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: { code: string } };
    assert.equal(body.error.code, 'invalid_request');
  });
});

test('POST /api/chat with a question over the max length returns 400', async () => {
  await withServer(testDeps(), async (baseUrl, cookie) => {
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ question: 'x'.repeat(2001) })
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: { code: string } };
    assert.equal(body.error.code, 'invalid_request');
  });
});

test('POST /api/chat without a session returns 401', async () => {
  await withServer(testDeps(), async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'hello' })
    });
    assert.equal(res.status, 401);
  });
});

test('DELETE /api/chat clears the authenticated user\'s conversation history', async () => {
  await withServer(testDeps(), async (baseUrl, cookie, userId) => {
    await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ question: 'hello' })
    });
    assert.ok((await getRecentMessages(userId)).length > 0);

    const res = await fetch(`${baseUrl}/api/chat`, { method: 'DELETE', headers: { cookie } });
    assert.equal(res.status, 204);
    assert.deepEqual(await getRecentMessages(userId), []);
  });
});

test('DELETE /api/chat without a session returns 401', async () => {
  await withServer(testDeps(), async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/chat`, { method: 'DELETE' });
    assert.equal(res.status, 401);
  });
});

test('GET /api/me returns the authenticated user', async () => {
  await withServer(testDeps(), async (baseUrl, cookie) => {
    const res = await fetch(`${baseUrl}/api/me`, { headers: { cookie } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { email: string };
    assert.equal(body.email.includes('chatroute-'), true);
  });
});

test('GET /api/me without a session returns 401', async () => {
  await withServer(testDeps(), async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/me`);
    assert.equal(res.status, 401);
  });
});
