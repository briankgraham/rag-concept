import crypto from 'crypto';
import type { AdpClient, PtoBalance } from './adp-client.interface.js';

const ANNUAL_ACCRUAL_DAYS = 20; // matches the company handbook's flat policy

function hashToInt(value: string): number {
  const hash = crypto.createHash('sha256').update(value).digest();
  return hash.readUInt32BE(0);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Mock ADP client for local development. Derives a deterministic-but-
 * plausible "used" amount from a hash of the employeeId, so a given
 * employee always sees the same numbers across requests/restarts, while
 * different employees see different numbers. Simulates network latency
 * so cache-TTL behavior (see pto.service.ts) is observable in testing.
 */
export class MockAdpClient implements AdpClient {
  async getPtoBalance(employeeId: string): Promise<PtoBalance> {
    await sleep(150 + (hashToInt(employeeId) % 250));

    const used = hashToInt(employeeId) % (ANNUAL_ACCRUAL_DAYS + 1); // [0, ANNUAL_ACCRUAL_DAYS], so remaining can be 0
    const remaining = ANNUAL_ACCRUAL_DAYS - used;

    return {
      employeeId,
      accrued: ANNUAL_ACCRUAL_DAYS,
      used,
      remaining,
      asOf: new Date().toISOString().slice(0, 10)
    };
  }
}
