import test from 'node:test';
import assert from 'node:assert/strict';
import type { Context, Next } from 'koa';
import { HttpError, errorHandler } from '../middleware/error-handler.js';

function fakeCtx(): Context {
  return { status: 0, body: undefined } as unknown as Context;
}

test('HttpError carries status, code, and message', () => {
  const err = new HttpError(404, 'not_found', 'Nothing here');
  assert.equal(err.status, 404);
  assert.equal(err.code, 'not_found');
  assert.equal(err.message, 'Nothing here');
  assert.ok(err instanceof Error);
});

test('errorHandler passes through successfully when next() does not throw', async () => {
  const ctx = fakeCtx();
  await errorHandler(ctx, async () => {
    ctx.status = 200;
  });
  assert.equal(ctx.status, 200);
});

test('errorHandler maps a thrown HttpError to its status/code/message', async () => {
  const ctx = fakeCtx();
  const next: Next = async () => {
    throw new HttpError(400, 'invalid_request', 'Bad input');
  };
  await errorHandler(ctx, next);
  assert.equal(ctx.status, 400);
  assert.deepEqual(ctx.body, { error: { code: 'invalid_request', message: 'Bad input' } });
});

test('errorHandler maps an unexpected error to a generic 500', async () => {
  const ctx = fakeCtx();
  const originalError = console.error;
  console.error = () => {}; // silence expected error log for this test
  try {
    const next: Next = async () => {
      throw new Error('boom');
    };
    await errorHandler(ctx, next);
  } finally {
    console.error = originalError;
  }
  assert.equal(ctx.status, 500);
  assert.deepEqual(ctx.body, { error: { code: 'internal_error', message: 'Something went wrong' } });
});

test('errorHandler maps a plain Error carrying its own 4xx status (e.g. koa-bodyparser) to that status', async () => {
  const ctx = fakeCtx();
  const next: Next = async () => {
    const err = new Error('Unexpected token b in JSON at position 0');
    Object.assign(err, { status: 400 });
    throw err;
  };
  await errorHandler(ctx, next);
  assert.equal(ctx.status, 400);
  assert.deepEqual(ctx.body, {
    error: { code: 'bad_request', message: 'Unexpected token b in JSON at position 0' }
  });
});

test('errorHandler does not trust a sub-400 status on a plain Error', async () => {
  const ctx = fakeCtx();
  const originalError = console.error;
  console.error = () => {};
  try {
    const next: Next = async () => {
      const err = new Error('x');
      Object.assign(err, { status: 399 });
      throw err;
    };
    await errorHandler(ctx, next);
  } finally {
    console.error = originalError;
  }
  assert.equal(ctx.status, 500);
});

test('errorHandler does not trust a 5xx status on a plain Error (message is not leaked)', async () => {
  const ctx = fakeCtx();
  const originalError = console.error;
  console.error = () => {};
  try {
    const next: Next = async () => {
      const err = new Error('some internal detail');
      Object.assign(err, { status: 502 });
      throw err;
    };
    await errorHandler(ctx, next);
  } finally {
    console.error = originalError;
  }
  assert.equal(ctx.status, 500);
  assert.deepEqual(ctx.body, { error: { code: 'internal_error', message: 'Something went wrong' } });
});

test('errorHandler treats a non-Error thrown value as a generic 500', async () => {
  const ctx = fakeCtx();
  const originalError = console.error;
  console.error = () => {};
  try {
    const next: Next = async () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw 'plain string error';
    };
    await errorHandler(ctx, next);
  } finally {
    console.error = originalError;
  }
  assert.equal(ctx.status, 500);
  assert.deepEqual(ctx.body, { error: { code: 'internal_error', message: 'Something went wrong' } });
});
