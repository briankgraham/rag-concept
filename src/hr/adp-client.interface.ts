export interface PtoBalance {
  employeeId: string;
  accrued: number;
  used: number;
  remaining: number;
  /** ISO date the balance is accurate as of. */
  asOf: string;
}

/**
 * Abstraction over ADP's HR API. This phase has no ADP credentials, so
 * AdpClient is implemented by AdpMockClient; swapping in a real HTTP
 * client later requires no changes to callers (pto.service.ts).
 */
export interface AdpClient {
  getPtoBalance(employeeId: string): Promise<PtoBalance>;
}
