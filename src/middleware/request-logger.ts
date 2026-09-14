import type { Context, Next } from 'koa';

export async function requestLogger(ctx: Context, next: Next): Promise<void> {
  const start = Date.now();
  await next();
  const ms = Date.now() - start;
  console.log(`${ctx.method} ${ctx.path} -> ${ctx.status} (${ms}ms)`);
}
