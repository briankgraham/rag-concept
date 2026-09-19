import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import Koa from 'koa';
import type { Server } from 'http';
import { createAuthRouter } from '../auth/auth.routes.js';
import { MockOktaClient, MOCK_EMPLOYEES, encodeMockCode } from '../auth/okta-client.mock.js';
import { pool } from '../db/pool.js';
import { errorHandler } from '../middleware/error-handler.js';
import { config } from '../config.js';

after(async () => {
  await pool.end();
});

function cookiePairs(res: Response): Record<string, string> {
  const pairs: Record<string, string> = {};
  for (const raw of res.headers.getSetCookie()) {
    const [pair] = raw.split(';');
    const eq = pair.indexOf('=');
    pairs[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return pairs;
}

function cookieHeader(cookies: Record<string, string>): string {
  return Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

async function withServer(fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const app = new Koa();
  const router = createAuthRouter({ oktaClient: new MockOktaClient() });
  app.use(errorHandler);
  app.use(router.routes());

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

test('GET /auth/login redirects to the mock picker and sets an oauth_state cookie', async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/auth/login`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    const location = res.headers.get('location') ?? '';
    assert.match(location, /^\/auth\/mock-login\?state=/);
    assert.ok(cookiePairs(res).oauth_state);
  });
});

test('GET /auth/mock-login renders a picker link for each mock employee', async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/auth/mock-login?state=abc123`);
    assert.equal(res.status, 200);
    const html = await res.text();
    for (const employee of MOCK_EMPLOYEES) {
      assert.ok(html.includes(employee.name), `missing ${employee.name} in picker`);
    }
  });
});

test('full login flow: login -> mock-login -> callback sets a session cookie', async () => {
  await withServer(async (baseUrl) => {
    const loginRes = await fetch(`${baseUrl}/auth/login`, { redirect: 'manual' });
    const cookies = cookiePairs(loginRes);
    const location = loginRes.headers.get('location')!;
    const state = new URL(location, baseUrl).searchParams.get('state')!;

    const code = encodeMockCode(MOCK_EMPLOYEES[0]);
    const callbackRes = await fetch(
      `${baseUrl}/auth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
      { redirect: 'manual', headers: { cookie: cookieHeader(cookies) } }
    );

    assert.equal(callbackRes.status, 302);
    // Post-login redirect goes to the configured frontend origin (its own
    // dev server or a separate docker service), not a relative '/' on the
    // API's own origin — see config.frontendUrl / auth.routes.ts callback.
    // Koa's ctx.redirect() re-stringifies an absolute URL via `new
    // URL(url).toString()`, which appends a trailing '/' when the config
    // value has no path — so compare against that same normalization
    // rather than the raw config string.
    assert.equal(callbackRes.headers.get('location'), new URL(config.frontendUrl).toString());
    const callbackCookies = cookiePairs(callbackRes);
    assert.ok(callbackCookies.session_token);
    assert.equal(callbackCookies.oauth_state, ''); // cleared
  });
});

test('GET /auth/callback rejects a missing/mismatched state', async () => {
  await withServer(async (baseUrl) => {
    // No oauth_state cookie sent at all -> mismatch.
    const res = await fetch(`${baseUrl}/auth/callback?code=whatever&state=whatever`);
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: { code: string } };
    assert.equal(body.error.code, 'invalid_state');
  });
});

test('GET /auth/callback with no query params at all still 400s (code/state default to empty string)', async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/auth/callback`);
    assert.equal(res.status, 400);
  });
});

test('GET /auth/mock-login with no state query param defaults it to an empty string', async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/auth/mock-login`);
    assert.equal(res.status, 200);
    const html = await res.text();
    // Each picker link's href ends in "&state=" (empty), rather than
    // "state=undefined" or throwing — that's what the `?? ''` covers.
    assert.ok(html.includes('&state='));
    assert.ok(!html.includes('undefined'));
  });
});

test('POST /auth/logout with a session cookie clears it', async () => {
  await withServer(async (baseUrl) => {
    const loginRes = await fetch(`${baseUrl}/auth/login`, { redirect: 'manual' });
    const loginCookies = cookiePairs(loginRes);
    const state = new URL(loginRes.headers.get('location')!, baseUrl).searchParams.get('state')!;
    const code = encodeMockCode(MOCK_EMPLOYEES[1]);

    const callbackRes = await fetch(
      `${baseUrl}/auth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
      { redirect: 'manual', headers: { cookie: cookieHeader(loginCookies) } }
    );
    const sessionCookies = cookiePairs(callbackRes);

    const logoutRes = await fetch(`${baseUrl}/auth/logout`, {
      method: 'POST',
      headers: { cookie: cookieHeader(sessionCookies) }
    });
    assert.equal(logoutRes.status, 204);
    assert.equal(cookiePairs(logoutRes).session_token, '');
  });
});

test('POST /auth/logout with no cookie still returns 204', async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/auth/logout`, { method: 'POST' });
    assert.equal(res.status, 204);
  });
});
