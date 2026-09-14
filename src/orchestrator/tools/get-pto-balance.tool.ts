import { z } from 'zod';
import type { ToolDefinition } from '../types.js';
import { formatPtoAnswer } from '../../hr/format.js';

const argsSchema = z.object({}).strict();
type Args = z.infer<typeof argsSchema>;

/**
 * Personal-data tool: resolves the CURRENT LOGGED-IN user's own PTO
 * balance from HR data (ADP), never any other employee's — the employee
 * id comes from the authenticated session (ctx.user), not from the model.
 * Bypasses the RAG/embeddings pipeline entirely, since no document holds
 * per-employee numbers and an LLM should never guess an exact balance.
 */
export const getPtoBalanceTool: ToolDefinition<Args> = {
  name: 'get_pto_balance',
  description:
    "Look up the current logged-in employee's own PTO (paid time off) balance — " +
    'accrued days, used days, and remaining days — from the HR system. Use this ' +
    'whenever the user asks about their own PTO/vacation/time-off days remaining, ' +
    'used, or accrued (e.g. "how many PTO days do I have left"). Do NOT use this ' +
    'for questions about the general PTO policy — use search_company_docs for that.',
  parameters: {
    type: 'object',
    properties: {},
    additionalProperties: false
  },
  argsSchema,
  async execute(_args, ctx) {
    const balance = await ctx.ptoService.getBalanceForEmployee(ctx.user.employeeId);
    return { content: { ...balance }, preferredAnswer: formatPtoAnswer(balance) };
  }
};
