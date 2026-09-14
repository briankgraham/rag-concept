import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { query, pool } from '../db/pool.js';

after(async () => {
  await pool.end();
});

test('query() executes a parameterized statement and returns rows', async () => {
  const result = await query<{ answer: number }>('SELECT $1::int AS answer', [42]);
  assert.equal(result.rows[0].answer, 42);
});

test('query() with no params works for a plain statement', async () => {
  const result = await query<{ one: number }>('SELECT 1 AS one');
  assert.equal(result.rows[0].one, 1);
});

test('DATE columns come back as plain YYYY-MM-DD strings, not Date objects', async () => {
  // Regression test for the bug found manually testing the PTO cache-hit
  // path: pg's default type parser turns DATE into a JS Date, which broke
  // formatPtoAnswer's rendering. See db/pool.ts's setTypeParser override.
  const result = await query<{ d: unknown }>("SELECT DATE '2026-09-13' AS d");
  assert.equal(typeof result.rows[0].d, 'string');
  assert.equal(result.rows[0].d, '2026-09-13');
});

test('TIMESTAMPTZ columns still come back as Date objects (relied on for TTL/expiry math)', async () => {
  const result = await query<{ t: unknown }>('SELECT now() AS t');
  assert.ok(result.rows[0].t instanceof Date);
});
