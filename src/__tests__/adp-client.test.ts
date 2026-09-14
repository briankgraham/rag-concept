import test from 'node:test';
import assert from 'node:assert/strict';
import { MockAdpClient } from '../hr/adp-client.mock.js';
import { RealAdpClient } from '../hr/adp-client.real.js';

test('MockAdpClient returns a deterministic balance for the same employeeId', async () => {
  const client = new MockAdpClient();
  const first = await client.getPtoBalance('E1001');
  const second = await client.getPtoBalance('E1001');

  assert.deepEqual(first, second);
  assert.equal(first.accrued, 20);
  assert.equal(first.accrued - first.used, first.remaining);
  assert.equal(first.employeeId, 'E1001');
  assert.match(first.asOf, /^\d{4}-\d{2}-\d{2}$/);
});

test('MockAdpClient returns different balances for different employees', async () => {
  const client = new MockAdpClient();
  const a = await client.getPtoBalance('E1001');
  const b = await client.getPtoBalance('E9999');

  // Not guaranteed mathematically for every possible pair, but true for
  // this fixed pair — asserts the hash actually varies by input.
  assert.notEqual(a.used, b.used);
});

test('RealAdpClient throws until implemented', async () => {
  const client = new RealAdpClient();
  await assert.rejects(() => client.getPtoBalance('E1001'), /not implemented/);
});
