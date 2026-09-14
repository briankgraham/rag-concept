import test from 'node:test';
import assert from 'node:assert/strict';
import Koa from 'koa';
import type { Server } from 'http';
import { corsMiddleware } from '../middleware/cors.js';

const ALLOWED = 'https://app.example.com';

async function withServer(
  allowedOrigins: string[],
  fn: (baseUrl: string) => Promise<void>
): Promise<void> {
  const app = new Koa();
  app.use(corsMiddleware(allowedOrigins));
  app.use((ctx) => {
    ctx.body = 'ok';
  });

  const server: Server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('failed to bind');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    await fn(baseUrl);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('an allowed configured origin gets Allow-Origin (that origin) and Allow-Credentials', async () => {
  await withServer([ALLOWED], async (baseUrl) => {
    const res = await fetch(baseUrl, { headers: { Origin: ALLOWED } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), ALLOWED);
    assert.equal(res.headers.get('access-control-allow-credentials'), 'true');
  });
});

test('an unconfigured/disallowed origin gets no Allow-Origin header', async () => {
  await withServer([ALLOWED], async (baseUrl) => {
    const res = await fetch(baseUrl, { headers: { Origin: 'https://evil.example' } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), null);
  });
});

test('a preflight OPTIONS request for an allowed origin gets CORS headers and skips downstream handlers', async () => {
  await withServer([ALLOWED], async (baseUrl) => {
    const res = await fetch(baseUrl, {
      method: 'OPTIONS',
      headers: {
        Origin: ALLOWED,
        'Access-Control-Request-Method': 'POST'
      }
    });
    assert.ok(res.status >= 200 && res.status < 300);
    assert.equal(res.headers.get('access-control-allow-origin'), ALLOWED);
    const body = await res.text();
    assert.equal(body, ''); // never reached the downstream `ctx.body = 'ok'` handler
  });
});

test('with no allowed origins configured (default), no origin is ever allowed', async () => {
  await withServer([], async (baseUrl) => {
    const res = await fetch(baseUrl, { headers: { Origin: ALLOWED } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), null);
  });
});
