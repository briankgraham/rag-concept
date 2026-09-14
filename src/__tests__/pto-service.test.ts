import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { PtoService } from '../hr/pto.service.js';
import { query, pool } from '../db/pool.js';
import type { AdpClient, PtoBalance } from '../hr/adp-client.interface.js';

/*
 * These tests exercise the real Postgres-backed cache — they need
 * DATABASE_URL reachable (defaults to postgres://postgres:postgres@localhost:5432/simple_rag,
 * see config.ts) with migrations applied (`npm run migrate`).
 */

function countingAdpClient(balance: Omit<PtoBalance, 'employeeId'>): {
  client: AdpClient;
  calls: () => number;
} {
  let calls = 0;
  const client: AdpClient = {
    getPtoBalance: (employeeId: string) => {
      calls++;
      return Promise.resolve({ employeeId, ...balance });
    }
  };
  return { client, calls: () => calls };
}

after(async () => {
  await pool.end();
});

test('getBalanceForEmployee: cache miss calls ADP and writes the cache row', async () => {
  const employeeId = `test-emp-miss-${Date.now()}`;
  const { client, calls } = countingAdpClient({ accrued: 20, used: 5, remaining: 15, asOf: '2026-01-01' });
  const service = new PtoService(client);

  const balance = await service.getBalanceForEmployee(employeeId);
  assert.equal(balance.remaining, 15);
  assert.equal(calls(), 1);

  const row = await query('SELECT * FROM pto_cache WHERE employee_id = $1', [employeeId]);
  assert.equal(row.rows.length, 1);
});

test('getBalanceForEmployee: cache hit within TTL does not call ADP again', async () => {
  const employeeId = `test-emp-hit-${Date.now()}`;
  const { client, calls } = countingAdpClient({ accrued: 20, used: 5, remaining: 15, asOf: '2026-01-01' });
  const service = new PtoService(client);

  await service.getBalanceForEmployee(employeeId); // populates cache
  assert.equal(calls(), 1);

  const second = await service.getBalanceForEmployee(employeeId);
  assert.equal(calls(), 1); // no additional ADP call
  assert.equal(second.remaining, 15);
});

test('getBalanceForEmployee: expired cache calls ADP again and updates the row', async () => {
  const employeeId = `test-emp-expired-${Date.now()}`;
  const { client, calls } = countingAdpClient({ accrued: 20, used: 5, remaining: 15, asOf: '2026-01-01' });
  const service = new PtoService(client);

  await service.getBalanceForEmployee(employeeId);
  assert.equal(calls(), 1);

  // Force the cached row to look old, well past any TTL.
  await query("UPDATE pto_cache SET fetched_at = now() - interval '1 day' WHERE employee_id = $1", [
    employeeId
  ]);

  await service.getBalanceForEmployee(employeeId);
  assert.equal(calls(), 2);
});
