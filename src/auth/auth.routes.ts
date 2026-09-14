import Router from '@koa/router';
import crypto from 'crypto';
import { config } from '../config.js';
import type { OktaClient } from './okta-client.interface.js';
import { MOCK_EMPLOYEES, encodeMockCode } from './okta-client.mock.js';
import { findOrCreateUser } from './users.repo.js';
import { createSession, destroySession } from './session.js';
import { HttpError } from '../middleware/error-handler.js';

const OAUTH_STATE_COOKIE = 'oauth_state';

export interface AuthRouterDeps {
  oktaClient: OktaClient;
}

/**
 * Router factory — takes its OktaClient rather than reaching for a
 * module-level singleton, same as createChatRouter. Which implementation
 * (mock vs real) gets constructed is a src/server.ts wiring decision, not
 * something this file decides for itself.
 */
export function createAuthRouter({ oktaClient }: AuthRouterDeps): Router {
  const router = new Router();

  router.get('/auth/login', (ctx) => {
    const state = crypto.randomBytes(16).toString('hex');
    ctx.cookies.set(OAUTH_STATE_COOKIE, state, {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.isProduction,
      maxAge: 5 * 60 * 1000
    });
    ctx.redirect(oktaClient.getAuthorizationUrl(state));
  });

  // Mock-only route: stands in for Okta's actual login page. Never present
  // against a real Okta tenant (RealOktaClient never generates a URL
  // pointing here).
  if (config.oktaMock) {
    router.get('/auth/mock-login', (ctx) => {
      const state = String(ctx.query.state ?? '');
      const links = MOCK_EMPLOYEES.map((profile) => {
        const code = encodeMockCode(profile);
        const href = `/auth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;
        return `<li><a href="${href}">${profile.name} (${profile.employeeId})</a></li>`;
      }).join('\n');

      ctx.type = 'html';
      ctx.body = `
        <h1>Mock Okta Login</h1>
        <p>Pick a user to sign in as (dev-only stand-in for real Okta SSO):</p>
        <ul>${links}</ul>
      `;
    });
  }

  router.get('/auth/callback', async (ctx) => {
    const code = String(ctx.query.code ?? '');
    const state = String(ctx.query.state ?? '');
    const expectedState = ctx.cookies.get(OAUTH_STATE_COOKIE);

    if (!code || !state || !expectedState || state !== expectedState) {
      throw new HttpError(400, 'invalid_state', 'Invalid or expired login attempt');
    }
    ctx.cookies.set(OAUTH_STATE_COOKIE, null);

    const profile = await oktaClient.exchangeCodeForProfile(code);
    const user = await findOrCreateUser(profile);
    const { token, expiresAt } = await createSession(user.id);

    ctx.cookies.set(config.sessionCookieName, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.isProduction,
      expires: expiresAt
    });

    ctx.redirect(config.frontendUrl);
  });

  router.post('/auth/logout', async (ctx) => {
    const token = ctx.cookies.get(config.sessionCookieName);
    if (token) {
      await destroySession(token);
      ctx.cookies.set(config.sessionCookieName, null);
    }
    ctx.status = 204;
  });

  return router;
}
