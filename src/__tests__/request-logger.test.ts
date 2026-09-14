import test from 'node:test';
import assert from 'node:assert/strict';
import type { Context } from 'koa';
import { requestLogger } from '../middleware/request-logger.js';

test('requestLogger calls next() and logs the method/path/status', async () => {
  const ctx = { method: 'GET', path: '/health', status: 200 } as unknown as Context;
  let nextCalled = false;

  const logged: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logged.push(msg);
  try {
    await requestLogger(ctx, async () => {
      nextCalled = true;
    });
  } finally {
    console.log = originalLog;
  }

  assert.equal(nextCalled, true);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /^GET \/health -> 200 \(\d+ms\)$/);
});
