import { query } from '../db/pool.js';
import { config } from '../config.js';
import type { AdpClient, PtoBalance } from './adp-client.interface.js';

interface CachedRow {
  employee_id: string;
  accrued: string;
  used: string;
  remaining: string;
  as_of: string;
  fetched_at: Date;
}

function rowToBalance(row: CachedRow): PtoBalance {
  return {
    employeeId: row.employee_id,
    accrued: Number(row.accrued),
    used: Number(row.used),
    remaining: Number(row.remaining),
    asOf: row.as_of
  };
}

/**
 * Wraps an AdpClient with a Postgres-backed cache. Takes the client via
 * constructor (like RagService takes an EmbeddingsService) rather than
 * reaching for a module-level singleton — that's what lets a test (or a
 * future caller) substitute a fake without touching the database, the
 * same way tests fake RagService today. See src/server.ts for how this
 * gets constructed and threaded into the orchestrator's ToolContext.
 */
export class PtoService {
  constructor(private adpClient: AdpClient) {}

  private async readCache(employeeId: string): Promise<CachedRow | null> {
    const result = await query<CachedRow>('SELECT * FROM pto_cache WHERE employee_id = $1', [employeeId]);
    return result.rows[0] ?? null;
  }

  private async writeCache(balance: PtoBalance): Promise<void> {
    await query(
      `INSERT INTO pto_cache (employee_id, accrued, used, remaining, as_of, fetched_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (employee_id) DO UPDATE
         SET accrued = $2, used = $3, remaining = $4, as_of = $5, fetched_at = now()`,
      [balance.employeeId, balance.accrued, balance.used, balance.remaining, balance.asOf]
    );
  }

  /**
   * Get an employee's PTO balance, preferring a fresh cache entry over
   * calling out to ADP on every question. Personal PTO data flows through
   * here exclusively — it never goes through the RAG/embeddings pipeline.
   */
  async getBalanceForEmployee(employeeId: string): Promise<PtoBalance> {
    const cached = await this.readCache(employeeId);

    if (cached && Date.now() - cached.fetched_at.getTime() < config.ptoCacheTtlMs) {
      return rowToBalance(cached);
    }

    const fresh = await this.adpClient.getPtoBalance(employeeId);
    await this.writeCache(fresh);
    return fresh;
  }
}
