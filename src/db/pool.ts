import pg from 'pg';
import { config } from '../config.js';

// pg's default type parser turns SQL DATE columns into JS Date objects,
// but every DATE column in this app (pto_cache.as_of) is treated as a
// plain YYYY-MM-DD string elsewhere (PtoBalance.asOf: string, and the ADP
// mock produces one directly) — without this, a value read back from the
// cache renders as a verbose Date.toString() instead of matching the
// fresh-fetch path. TIMESTAMPTZ columns (sessions.expires_at,
// pto_cache.fetched_at) are untouched: those ARE relied on as Date objects
// (see session.ts, pto.service.ts's cache-TTL check).
pg.types.setTypeParser(pg.types.builtins.DATE, (value: string) => value);

export const pool = new pg.Pool({ connectionString: config.databaseUrl });

/**
 * Thin query helper. Keeps callers from importing `pool` directly and
 * gives us one place to add logging/metrics later.
 */
export function query<T extends pg.QueryResultRow = any>(
  text: string,
  params?: unknown[]
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, params);
}
