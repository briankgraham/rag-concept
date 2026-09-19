import type { ChatProvider } from '../providers/chat-provider.interface.js';
import { RagService } from '../rag/rag.service.js';
import { PtoService } from '../hr/pto.service.js';
import { runOrchestrator } from '../orchestrator/orchestrator.js';
import type { User } from '../auth/users.repo.js';
import { getRecentMessages, appendMessages } from './conversation.repo.js';

export type ChatSource = 'pto_lookup' | 'rag' | 'direct';

export interface ChatAnswer {
  answer: string;
  source: ChatSource;
  // Doc(s) the answer actually cited, when source === 'rag' (empty
  // otherwise — a PTO lookup or a direct answer has no doc citation).
  // Lets the client show "sourced from: remote_work_policy.md" instead of
  // just the coarse rag/pto_lookup/direct label.
  sources: string[];
}

/** The services answerChatMessage needs — one options object, same shape used by createChatRouter. */
export interface ChatDeps {
  chat: ChatProvider;
  ragService: RagService;
  ptoService: PtoService;
  debug: boolean;
}

/**
 * Best-effort label for the response, derived from which tool(s) the
 * orchestrator attempted to invoke — useful for logging/analytics/QA. Uses
 * attemptedToolNames (not toolCalls) deliberately: a get_pto_balance call
 * that failed mid-execution (e.g. a transient DB error) is still a
 * personal-data-lookup attempt for labeling purposes, and toolCalls only
 * ever records successes. If the model called more than one tool, the
 * personal-data one wins for labeling purposes since that's the more
 * specific/sensitive path.
 */
function deriveSource(toolNames: string[]): ChatSource {
  if (toolNames.includes('get_pto_balance')) return 'pto_lookup';
  if (toolNames.includes('search_company_docs')) return 'rag';
  return 'direct';
}

/**
 * Answers one chat message for an authenticated user via the tool-calling
 * orchestrator (src/orchestrator/orchestrator.ts): the LLM itself decides,
 * from each tool's schema and description, whether this question needs a
 * personal-data lookup (PTO balance), a docs search, or neither — rather
 * than a hand-rolled keyword/classifier branch deciding for it. Adding a
 * new capability later means adding a tool, not touching this function.
 *
 * Also threads the user's single ongoing conversation (conversation.repo.ts)
 * through: prior turns are loaded and passed to the orchestrator so a
 * follow-up question (e.g. answering a clarifying question the model asked
 * last turn) has that context, and this turn's question/answer are
 * appended afterward so the next call sees it too.
 */
export async function answerChatMessage(deps: ChatDeps, user: User, question: string): Promise<ChatAnswer> {
  const history = await getRecentMessages(user.id);
  const result = await runOrchestrator(question, { user, ...deps }, history);
  await appendMessages(user.id, [
    { role: 'user', content: question },
    { role: 'assistant', content: result.answer }
  ]);
  return {
    answer: result.answer,
    source: deriveSource(result.attemptedToolNames),
    sources: result.retrievedSources
  };
}
