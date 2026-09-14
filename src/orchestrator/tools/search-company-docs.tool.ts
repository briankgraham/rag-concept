import { z } from 'zod';
import type { ToolDefinition } from '../types.js';

const argsSchema = z
  .object({
    queries: z
      .array(z.string().min(1))
      .min(1)
      .max(4)
      .describe('2-4 concise search queries covering different phrasings/aspects of the question')
  })
  .strict();
type Args = z.infer<typeof argsSchema>;

/**
 * General-knowledge tool: vector search over the company docs corpus
 * (handbook, benefits, policies, onboarding, engineering docs, etc). Use
 * for anything documented and NOT specific to the current user's personal
 * data — those questions should go through a dedicated tool instead (see
 * get-pto-balance.tool.ts).
 */
export const searchCompanyDocsTool: ToolDefinition<Args> = {
  name: 'search_company_docs',
  description:
    'Search the company knowledge base (employee handbook, benefits overview, security ' +
    'policy, onboarding checklist, engineering docs, etc.) for passages relevant to a ' +
    'general question. Use this for company policy, procedures, or any documented ' +
    "information that is NOT the current user's personal/individual data. Provide 2-4 " +
    'varied search queries covering different phrasings to improve recall, then answer ' +
    "strictly from the returned context — say you don't know if it is not covered.",
  parameters: {
    type: 'object',
    properties: {
      queries: {
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
        maxItems: 4,
        description: '2-4 concise search queries covering different phrasings/aspects of the question'
      }
    },
    required: ['queries'],
    additionalProperties: false
  },
  argsSchema,
  async execute(args, ctx) {
    const { context, sourceCount, sources } = await ctx.ragService.searchDocs(args.queries);
    return { content: { context, sourceCount, sources }, sourcesUsed: sources };
  }
};
