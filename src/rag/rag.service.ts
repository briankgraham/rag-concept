import type { ChatProvider } from '../providers/chat-provider.interface.js';
import { EmbeddingsService, type Chunk } from './embeddings.service.js';
import { chatCompletion } from './llm.js';

const SYSTEM_QUERY_GEN = `You are an assistant that suggests concise search queries (2–4) users might run in a vector search over company documentation. Return ONLY a JSON list of strings.`;

const SYSTEM_ANSWER = `Answer the question strictly based on the provided context. If the answer is not contained, say you don't know.`;

/**
 * General-purpose "answer from company docs" pipeline: propose search
 * queries -> multi-search embeddings -> build context -> answer via LLM.
 *
 * This is shared by the CLI and the web app's chat endpoint. It is used
 * ONLY for general policy/docs questions — personal data lookups (like a
 * user's own PTO balance) are handled by a separate structured-data path
 * (see src/orchestrator/orchestrator.ts and src/hr/pto.service.ts) and
 * never go through this pipeline.
 */
export class RagService {
  constructor(
    private chat: ChatProvider,
    private embeddingsService: EmbeddingsService,
    private debug: boolean = false
  ) {}

  async proposeSearchQueries(question: string): Promise<string[]> {
    const raw = await chatCompletion(
      this.chat,
      [
        { role: 'system', content: SYSTEM_QUERY_GEN },
        { role: 'user', content: question }
      ],
      { debug: this.debug }
    );
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const queries = parsed
          .slice(0, 4)
          .map(String)
          .filter((q) => q.trim().length > 0);
        if (queries.length > 0) return queries;
      }
    } catch {
      /* ignore */
    }
    const fallback = question
      .split(' ')
      .filter((q) => q.trim().length > 0)
      .slice(0, 4);
    return fallback.length > 0 ? fallback : [question];
  }

  buildContext(chunks: Chunk[]): string {
    return chunks.map((chunk) => `### Source: ${chunk.source}\n${chunk.content}`).join('\n');
  }

  /** Distinct source documents across a set of chunks, sorted for a deterministic order. */
  private distinctSources(chunks: Chunk[]): string[] {
    return [...new Set(chunks.map((c) => c.source))].sort();
  }

  /**
   * Search the docs corpus with one or more queries and return the
   * assembled context text. Used by the orchestrator's search_company_docs
   * tool (src/orchestrator/tools/search-company-docs.tool.ts) — unlike
   * answerFromDocs(), this does not itself call the LLM to produce an
   * answer; the orchestrator's own model turn does that from the tool
   * result, possibly alongside other tools.
   */
  async searchDocs(queries: string[]): Promise<{ context: string; sourceCount: number; sources: string[] }> {
    const chunks = await this.embeddingsService.multiSearch(queries, 3);
    // Distinct documents, not chunks — a single doc split into several
    // chunks (all matched across the sub-queries) previously inflated this
    // count, overstating how many different documents corroborate the
    // answer to the model consuming this tool result. `sources` is that
    // same distinct set, surfaced so a caller (the orchestrator, then
    // chat.service.ts) can cite exactly which doc(s) an answer drew from
    // instead of just a count.
    const sources = this.distinctSources(chunks);
    return { context: this.buildContext(chunks), sourceCount: sources.length, sources };
  }

  async answerFromDocs(question: string): Promise<{ answer: string; sources: string[] }> {
    if (this.debug) console.log('\n[DEBUG] Generating search queries...');
    const queries = await this.proposeSearchQueries(question);
    if (this.debug) console.log('[DEBUG] Search queries:', queries);

    if (this.debug) console.log('[DEBUG] Searching embeddings...');
    const chunks = await this.embeddingsService.multiSearch(queries, 3);
    if (this.debug) console.log(`[DEBUG] Found ${chunks.length} chunks`);

    const context = this.buildContext(chunks);
    const sources = this.distinctSources(chunks);

    const answer = await chatCompletion(
      this.chat,
      [
        { role: 'system', content: SYSTEM_ANSWER },
        { role: 'system', content: `Context:\n${context}` },
        { role: 'user', content: question }
      ],
      { debug: this.debug }
    );
    return { answer, sources };
  }
}
