import type { AdpClient, PtoBalance } from './adp-client.interface.js';

/**
 * Real ADP API client — NOT built yet. This phase has no ADP credentials,
 * so integration is deferred. When ready, implement this against ADP's
 * actual PTO/time-off balance endpoint (shape TBD by their API) and swap
 * it in wherever MockAdpClient is currently constructed (src/server.ts).
 * No other code should need to change.
 */
export class RealAdpClient implements AdpClient {
  async getPtoBalance(_employeeId: string): Promise<PtoBalance> {
    throw new Error('RealAdpClient is not implemented yet. Set ADP_MOCK=true.');
  }
}
