import type { ZodType } from 'zod';
import type { ChatProvider } from '../providers/chat-provider.interface.js';
import type { RagService } from '../rag/rag.service.js';
import type { PtoService } from '../hr/pto.service.js';
import type { User } from '../auth/users.repo.js';

/**
 * Everything a tool needs to do its job. Every dependency a tool touches
 * (RagService, PtoService, ...) is injected here rather than imported as a
 * module-level singleton — that's what makes a tool's execute() testable
 * with a plain fake object instead of a live database or API. Adding a new
 * data source (e.g. a benefits-enrollment system, a paystub API) means
 * constructing it once in src/server.ts and adding one field here.
 */
export interface ToolContext {
  user: User;
  chat: ChatProvider;
  ragService: RagService;
  ptoService: PtoService;
  debug: boolean;
}

export interface ToolResult {
  /** Structured data handed back to the model as the tool's result. */
  content: Record<string, unknown>;
  /**
   * An exact sentence the tool would like the model to relay verbatim
   * rather than paraphrase — used for numeric/factual data (like a PTO
   * balance) where an LLM rewording risks getting the number wrong.
   */
  preferredAnswer?: string;
  /**
   * Source document(s) this result was drawn from, if any (e.g.
   * search_company_docs' matched doc paths) — orchestrator.ts aggregates
   * this across all successful tool calls in a run into
   * OrchestratorResult.retrievedSources, which chat.service.ts surfaces to
   * the client as citations. Not every tool has a notion of "source" (e.g.
   * get_pto_balance doesn't), so this is optional.
   */
  sourcesUsed?: string[];
}

/**
 * A single capability the orchestrator can invoke. `parameters` is the
 * JSON Schema advertised to the LLM (JSON Schema function-calling spec);
 * `argsSchema` is the Zod schema used to validate/parse the model's raw
 * arguments before execute() ever sees them, so a malformed tool call
 * fails fast with a clear error fed back to the model instead of a runtime
 * crash. Register a new tool by adding one file under tools/ and listing
 * it in tools/index.ts — no other orchestrator code changes.
 */
export interface ToolDefinition<TArgs = any> {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  argsSchema: ZodType<TArgs>;
  execute(args: TArgs, ctx: ToolContext): Promise<ToolResult>;
}
