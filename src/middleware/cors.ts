import cors from '@koa/cors';
import type Koa from 'koa';

/**
 * CORS middleware, gated by an explicit allowlist rather than '*' —
 * credentials: true is required since the session cookie must ride along
 * on cross-origin calls, and browsers reject wildcard origin combined with
 * credentialed requests outright. Returning '' from origin() omits
 * Access-Control-Allow-Origin entirely, so an unconfigured/disallowed
 * origin fails closed exactly as it does today with no CORS middleware at
 * all (same-origin requests are unaffected either way — browsers don't
 * apply CORS checks to them).
 */
export function corsMiddleware(allowedOrigins: string[]): Koa.Middleware {
  return cors({
    origin: (ctx) => {
      const origin = ctx.get('Origin');
      return allowedOrigins.includes(origin) ? origin : '';
    },
    credentials: true,
    allowMethods: ['GET', 'POST']
  });
}
