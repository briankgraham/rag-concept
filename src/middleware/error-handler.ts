import type { Context, Next } from 'koa';

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string
  ) {
    super(message);
  }
}

// Some upstream middleware (e.g. koa-bodyparser, via co-body) throws a
// plain Error carrying its own `status` rather than our HttpError — a
// malformed-JSON request body is a real 4xx, not a server fault. Trust
// that status only in the 4xx range: a library-set 5xx status doesn't mean
// its (possibly internal) message is safe to hand back to the client.
function clientErrorStatus(err: Error): number | undefined {
  const status = (err as Error & { status?: unknown }).status;
  return typeof status === 'number' && status >= 400 && status < 500 ? status : undefined;
}

export async function errorHandler(ctx: Context, next: Next): Promise<void> {
  try {
    await next();
  } catch (err) {
    if (err instanceof HttpError) {
      ctx.status = err.status;
      ctx.body = { error: { code: err.code, message: err.message } };
      return;
    }
    const status = err instanceof Error ? clientErrorStatus(err) : undefined;
    if (status !== undefined) {
      ctx.status = status;
      ctx.body = { error: { code: 'bad_request', message: (err as Error).message } };
      return;
    }
    console.error('Unhandled error:', err);
    ctx.status = 500;
    ctx.body = { error: { code: 'internal_error', message: 'Something went wrong' } };
  }
}
