import type { PtoBalance } from './adp-client.interface.js';

/**
 * Pure formatting helper, kept separate from the tool/execute plumbing so
 * it's testable without a database. This is the sentence the orchestrator
 * is told to relay verbatim (see ToolResult.preferredAnswer) rather than
 * let the LLM paraphrase — exact numbers shouldn't be left to chance.
 */
export function formatPtoAnswer(balance: PtoBalance): string {
  const dayWord = balance.remaining === 1 ? 'day' : 'days';
  return `You have ${balance.remaining} ${dayWord} of PTO left (accrued ${balance.accrued}, used ${balance.used}, as of ${balance.asOf}).`;
}
