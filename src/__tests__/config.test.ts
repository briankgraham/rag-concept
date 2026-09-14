import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';

const execFileAsync = promisify(execFile);

/*
 * config.ts computes its exported `config` object once, eagerly, at import
 * time — there's no way to re-run it with different env vars within one
 * process. So each scenario here spawns a fresh `node` process instead.
 */
const CONFIG_JS_PATH = new URL('../config.js', import.meta.url).pathname;

async function runWithEnv(env: NodeJS.ProcessEnv, script: string): Promise<{ stdout: string; code: number }> {
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      ['--input-type=module', '-e', script],
      { env, cwd: os.tmpdir() } // tmpdir: guarantees no stray .env file influences the result
    );
    return { stdout, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; code?: number };
    return { stdout: e.stdout ?? '', code: e.code ?? 1 };
  }
}

test('config throws when OPENAI_API_KEY is missing and no .env is present', async () => {
  const script = `
    import('${CONFIG_JS_PATH}')
      .then(() => { console.log('NO_THROW'); })
      .catch((err) => { console.log('THREW: ' + err.message); process.exitCode = 1; });
  `;
  const { stdout, code } = await runWithEnv({ PATH: process.env.PATH }, script);
  assert.equal(code, 1);
  assert.match(stdout, /THREW: Missing required environment variable: OPENAI_API_KEY/);
});

test('config applies documented defaults when only OPENAI_API_KEY is set', async () => {
  const script = `
    const { config } = await import('${CONFIG_JS_PATH}');
    console.log(JSON.stringify(config));
  `;
  const { stdout, code } = await runWithEnv({ PATH: process.env.PATH, OPENAI_API_KEY: 'sk-test' }, script);
  assert.equal(code, 0);
  const config = JSON.parse(stdout.trim());
  assert.equal(config.port, 3000);
  assert.equal(config.databaseUrl, 'postgres://postgres:postgres@localhost:5432/simple_rag');
  assert.equal(config.sessionCookieName, 'session_token');
  assert.equal(config.sessionTtlMs, 7 * 24 * 60 * 60 * 1000);
  assert.equal(config.ptoCacheTtlMs, 15 * 60 * 1000);
  assert.equal(config.maxConversationMessages, 20);
  assert.equal(config.oktaMock, true);
  assert.equal(config.adpMock, true);
  assert.deepEqual(config.allowedOrigins, []);
  assert.equal(config.isProduction, false);
});

test('config honors every override env var', async () => {
  const script = `
    const { config } = await import('${CONFIG_JS_PATH}');
    console.log(JSON.stringify(config));
  `;
  const { stdout, code } = await runWithEnv(
    {
      PATH: process.env.PATH,
      OPENAI_API_KEY: 'sk-test',
      PORT: '4000',
      DATABASE_URL: 'postgres://example/custom_db',
      SESSION_TTL_MS: '1000',
      PTO_CACHE_TTL_MS: '2000',
      MAX_CONVERSATION_MESSAGES: '6',
      OKTA_MOCK: 'false',
      ADP_MOCK: 'false',
      NODE_ENV: 'production',
      ALLOWED_ORIGIN: ' https://app.example.com , https://staging.example.com ,'
    },
    script
  );
  assert.equal(code, 0);
  const config = JSON.parse(stdout.trim());
  assert.equal(config.port, 4000);
  assert.equal(config.databaseUrl, 'postgres://example/custom_db');
  assert.equal(config.sessionTtlMs, 1000);
  assert.equal(config.ptoCacheTtlMs, 2000);
  assert.equal(config.maxConversationMessages, 6);
  assert.equal(config.oktaMock, false);
  assert.equal(config.adpMock, false);
  assert.deepEqual(config.allowedOrigins, ['https://app.example.com', 'https://staging.example.com']);
  assert.equal(config.isProduction, true);
});

test('config throws in production when OKTA_MOCK is left at its default (true)', async () => {
  const script = `
    import('${CONFIG_JS_PATH}')
      .then(() => { console.log('NO_THROW'); })
      .catch((err) => { console.log('THREW: ' + err.message); process.exitCode = 1; });
  `;
  const { stdout, code } = await runWithEnv(
    { PATH: process.env.PATH, OPENAI_API_KEY: 'sk-test', NODE_ENV: 'production', ADP_MOCK: 'false' },
    script
  );
  assert.equal(code, 1);
  assert.match(stdout, /THREW: OKTA_MOCK must be false in production/);
});

test('config throws in production when ADP_MOCK is left at its default (true)', async () => {
  const script = `
    import('${CONFIG_JS_PATH}')
      .then(() => { console.log('NO_THROW'); })
      .catch((err) => { console.log('THREW: ' + err.message); process.exitCode = 1; });
  `;
  const { stdout, code } = await runWithEnv(
    { PATH: process.env.PATH, OPENAI_API_KEY: 'sk-test', NODE_ENV: 'production', OKTA_MOCK: 'false' },
    script
  );
  assert.equal(code, 1);
  assert.match(stdout, /THREW: ADP_MOCK must be false in production/);
});
