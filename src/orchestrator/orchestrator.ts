import { TOOLS, findTool } from './tools/index.js';
import type { ToolContext } from './types.js';
import { HttpError } from '../middleware/error-handler.js';
import type { ConversationMessage } from '../chat/conversation.repo.js';
import type { ChatMessage, ToolSpec } from '../providers/chat-provider.interface.js';

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

function toToolSpecs(): ToolSpec[] {
  return TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters
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
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history.map((m): ChatMessage => ({ role: m.role, content: m.content })),
    { role: 'user', content: question }
  ];
  const toolCalls: ToolCallRecord[] = [];
  const attemptedToolNames: string[] = [];
  const retrievedSourcesSet = new Set<string>();
  const tools = toToolSpecs();

  for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
    if (ctx.debug) {
      console.log(`\n[DEBUG] Orchestrator turn ${turn + 1} request:`);
      console.log(JSON.stringify({ messages, tools }, null, 2));
    }

    const { message } = await ctx.chat.completeWithTools(messages, tools);
    messages.push(message);

    if (ctx.debug) {
      console.log('[DEBUG] Orchestrator turn response:', JSON.stringify(message, null, 2));
    }

    if (!message.toolCalls || message.toolCalls.length === 0) {
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

    // Execute every tool call this turn concurrently — they're independent
    // reads with no ordering dependency between them (see orchestrator.ts's
    // plan doc / commit message) — then apply results in the original call
    // order, not completion order, so toolCalls/attemptedToolNames/the
    // pushed tool messages stay deterministic regardless of which call
    // actually finishes first.
    const outcomes = await Promise.all(
      message.toolCalls.map(async (call) => {
        const tool = findTool(call.name);

        if (!tool) {
          return { call, success: false as const, resultPayload: { error: `Unknown tool: ${call.name}` } };
        }

        try {
          const rawArgs = call.arguments ? JSON.parse(call.arguments) : {};
          const args = tool.argsSchema.parse(rawArgs);
          const result = await tool.execute(args, ctx);
          const resultPayload = result.preferredAnswer
            ? { ...result.content, preferredAnswer: result.preferredAnswer }
            : result.content;
          return { call, tool, success: true as const, args, resultPayload, sourcesUsed: result.sourcesUsed };
        } catch (err) {
          return {
            call,
            tool,
            success: false as const,
            resultPayload: { error: err instanceof Error ? err.message : String(err) }
          };
        }
      })
    );

    for (const outcome of outcomes) {
      if (outcome.tool) {
        attemptedToolNames.push(outcome.tool.name);
        if (outcome.success) {
          toolCalls.push({ name: outcome.tool.name, args: outcome.args });
          outcome.sourcesUsed?.forEach((source) => retrievedSourcesSet.add(source));
        }
      }

      messages.push({
        role: 'tool',
        toolCallId: outcome.call.id,
        content: JSON.stringify(outcome.resultPayload)
      });
    }
  }

  throw new HttpError(
    500,
    'tool_loop_exceeded',
    'Could not produce an answer after multiple tool calls — try rephrasing your question.'
  );
}
