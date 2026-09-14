import type OpenAI from 'openai';
import { TOOLS, findTool } from './tools/index.js';
import type { ToolContext } from './types.js';
import { HttpError } from '../middleware/error-handler.js';
import type { ConversationMessage } from '../chat/conversation.repo.js';

type ChatCompletionMessageParam = OpenAI.ChatCompletionMessageParam;
type ChatCompletionTool = OpenAI.ChatCompletionTool;

const MODEL = 'gpt-5';
const MAX_TOOL_TURNS = 4;

const SYSTEM_PROMPT = `You are the internal assistant for a company's employees, answering questions via tools rather than from your own knowledge.

Rules:
- For anything about the CURRENT user's own personal data (their PTO/vacation balance, etc.), call the matching tool — never guess or estimate a number yourself.
- For general company policy, benefits, procedures, or other documented information, call search_company_docs with a few varied search queries, then answer strictly from what the search returns. If the search doesn't cover it, say you don't know.
- If a tool result includes a "preferredAnswer" field, relay that fact/number exactly as given rather than rephrasing or recalculating it — numeric accuracy matters more than style here.
- Never mix a user's personal data into a general/policy answer meant for anyone else.`;

export interface ToolCallRecord {
  name: string;
  args: unknown;
}

export interface OrchestratorResult {
  answer: string;
  // Only successful tool calls — see toOrchestratorResult tests and
  // orchestrator.test.ts for the documented "never recorded on failure"
  // contract callers (the eval script, tests) rely on.
  toolCalls: ToolCallRecord[];
  // Every tool name the model attempted to call this turn, regardless of
  // whether it succeeded — chat.service.ts uses this (not toolCalls) to
  // label a response's source, since a *failed* get_pto_balance call is
  // still a personal-data-lookup attempt for logging/analytics purposes.
  attemptedToolNames: string[];
  // Deduped, sorted union of ToolResult.sourcesUsed across every
  // successful tool call this run (only search_company_docs sets it
  // today) — chat.service.ts surfaces this to the client as citations.
  retrievedSources: string[];
}

function toOpenAiTools(): ChatCompletionTool[] {
  return TOOLS.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    }
  }));
}

/**
 * Runs the tool-calling agent loop for one user question: the LLM decides
 * which tool(s) to call (if any) based on their schemas/descriptions, we
 * execute them and feed results back, and repeat until the model returns
 * a final answer or MAX_TOOL_TURNS is hit.
 *
 * This replaces a hand-rolled keyword/single-shot intent classifier with a
 * proper orchestrator: adding a new capability is "write a tool", not
 * "add a branch" — the model itself decides intent from the tool schemas.
 *
 * `history` is the prior turns of this user's single ongoing conversation
 * (see src/chat/conversation.repo.ts), oldest first — spliced in between
 * the system prompt and the new question so a follow-up (e.g. answering a
 * clarifying question the model itself asked last turn) has that context.
 * Only final user/assistant text turns are replayed; intra-request tool
 * calls stay ephemeral within a single run, same as before.
 */
export async function runOrchestrator(
  question: string,
  ctx: ToolContext,
  history: ConversationMessage[] = []
): Promise<OrchestratorResult> {
  const start = Date.now();
  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history.map((m): ChatCompletionMessageParam => ({ role: m.role, content: m.content })),
    { role: 'user', content: question }
  ];
  const toolCalls: ToolCallRecord[] = [];
  const attemptedToolNames: string[] = [];
  const retrievedSourcesSet = new Set<string>();
  const tools = toOpenAiTools();

  for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
    if (ctx.debug) {
      console.log(`\n[DEBUG] Orchestrator turn ${turn + 1} request:`);
      console.log(JSON.stringify({ model: MODEL, messages, tools }, null, 2));
    }

    const response = await ctx.openai.chat.completions.create({
      model: MODEL,
      messages,
      tools,
      tool_choice: 'auto'
    });

    const message = response.choices[0].message;
    messages.push(message);

    if (ctx.debug) {
      console.log('[DEBUG] Orchestrator turn response:', JSON.stringify(message, null, 2));
    }

    if (!message.tool_calls || message.tool_calls.length === 0) {
      const retrievedSources = [...retrievedSourcesSet].sort();
      // Always-on, one-line per-request summary — the /chat request-level
      // ms from request-logger.ts doesn't break down tool/turn count, and
      // the debug dumps above are opt-in only; this is cheap signal for
      // "which questions are slow/expensive" without either of those.
      console.log(
        `[orchestrator] turns=${turn + 1} tools=[${attemptedToolNames.join(', ') || 'none'}] ms=${Date.now() - start}`
      );
      return { answer: message.content ?? '', toolCalls, attemptedToolNames, retrievedSources };
    }

    for (const call of message.tool_calls) {
      const tool = findTool(call.function.name);
      let resultPayload: Record<string, unknown>;

      if (!tool) {
        resultPayload = { error: `Unknown tool: ${call.function.name}` };
      } else {
        attemptedToolNames.push(tool.name);
        try {
          const rawArgs = call.function.arguments ? JSON.parse(call.function.arguments) : {};
          const args = tool.argsSchema.parse(rawArgs);
          const result = await tool.execute(args, ctx);
          toolCalls.push({ name: tool.name, args });
          result.sourcesUsed?.forEach((source) => retrievedSourcesSet.add(source));
          resultPayload = result.preferredAnswer
            ? { ...result.content, preferredAnswer: result.preferredAnswer }
            : result.content;
        } catch (err) {
          resultPayload = { error: err instanceof Error ? err.message : String(err) };
        }
      }

      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(resultPayload)
      });
    }
  }

  throw new HttpError(
    500,
    'tool_loop_exceeded',
    'Could not produce an answer after multiple tool calls — try rephrasing your question.'
  );
}
