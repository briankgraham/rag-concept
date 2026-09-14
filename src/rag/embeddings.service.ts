import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type { Pool } from 'pg';
import pgvector from 'pgvector';
import OpenAI from 'openai';
// cl100k_base is the encoding OpenAI's text-embedding-3-small (and -large,
// and gpt-3.5/4) actually tokenizes with — chunking by token count instead
// of raw character count keeps CHUNK_SIZE meaningful across unicode-heavy
// or markdown-table-heavy docs, where character count is a poor proxy for
// what the embedding model actually sees.
import { encode, decode } from 'gpt-tokenizer/encoding/cl100k_base';

const CHUNK_SIZE = 400; // tokens, not characters — see chunkText()

// ~15% overlap between adjacent chunks within an oversized section, so a
// fact near a chunk boundary still appears whole in at least one chunk
// instead of being split between two.
const OVERLAP_TOKENS = Math.round(CHUNK_SIZE * 0.15);

// Bump this whenever chunkText()'s behavior changes. hashContent() folds it
// into the stored hash so an unchanged file is still treated as "changed"
// after a chunking-algorithm change, forcing rebuildCache() to re-chunk and
// re-embed it even though its on-disk content hash alone hasn't moved.
const CHUNKER_VERSION = 2;

// Reciprocal Rank Fusion constant, used by fuseRankings() below. Swept
// against npm run eval:retrieval's 12-case suite (source-level recall) at
// RRF_CONSTANT ∈ {10, 30, 60, 100} with CANDIDATE_POOL_MULTIPLIER held at
// its default (2): every value scored 12/12, with no case-level
// differences in the retrieved-source sets either — RRF_CONSTANT has no
// measurable effect at this corpus/eval size. Kept 60 (the commonly-used
// default) rather than picking an unsupported "tuned" value. Re-run this
// sweep if eval:retrieval grows enough cases (e.g. more exact-term ones,
// see CLAUDE.md) to actually discriminate between values.
const RRF_CONSTANT = 60;

// Multiplier on k used to size the dense/keyword candidate pool that
// fuseRankings() draws from (multiSearch() below). Swept at
// CANDIDATE_POOL_MULTIPLIER ∈ {2, 3, 4} with RRF_CONSTANT held at 60:
// also 12/12 across the board, no case-level differences. Kept 2 for the
// same reason as RRF_CONSTANT above — validated, not just assumed.
const CANDIDATE_POOL_MULTIPLIER = 2;

export type Chunk = { source: string; content: string };

interface SearchResult {
  id: string;
  score: number;
  chunk: Chunk;
}

/**
 * Service for managing document embeddings and vector search.
 *
 * Source markdown files live on local disk (docsDir); chunking + embedding
 * results are stored in Postgres (doc_sources/doc_chunks, see
 * src/db/migrations/004_create_rag_tables.sql) via pgvector, not in an
 * in-process cache or a JSON file. rebuildCache() is incremental: it only
 * re-embeds files whose content actually changed since the last rebuild.
 */
export class EmbeddingsService {
  private docsDir: string;
  private openai: OpenAI;
  private pool: Pool;
  private initialized = false;

  constructor(openai: OpenAI, docsDir: string, pool: Pool) {
    this.openai = openai;
    this.docsDir = docsDir;
    this.pool = pool;
  }

  /**
   * Initialize the service. Rebuilds from the local docs directory only if
   * doc_chunks is empty (e.g. first run against a fresh database) — an
   * existing table is trusted as-is, matching the old "load cache if
   * present" behavior. When trusting an existing table, warnIfStale() still
   * checks (read-only) whether that trust is actually still warranted.
   */
  async initialize(): Promise<void> {
    const result = await this.pool.query<{ count: string }>('SELECT count(*) FROM doc_chunks');
    if (Number(result.rows[0].count) === 0) {
      await this.rebuildCache();
    } else {
      await this.warnIfStale();
    }
    this.initialized = true;
  }

  /**
   * Read-only startup safety check: compares each on-disk doc's content
   * hash against what doc_sources has stored, without writing anything.
   * initialize() trusts an existing (non-empty) doc_chunks table as-is
   * rather than eagerly re-syncing it (see initialize() above) — that's a
   * deliberate tradeoff for fast/predictable startup, but it means a
   * source file edited on disk without rebuildCache() ever running again
   * (e.g. a deploy that updates docsDir but not the indexer step) would
   * otherwise silently serve stale or missing content with no signal
   * anywhere. This doesn't fix that — fixing means actually calling
   * rebuildCache() — it only makes the drift visible.
   */
  private async warnIfStale(): Promise<void> {
    const files = this.docsDirExists() ? this.walkFiles(this.docsDir, '.md') : [];
    const sources = new Map(files.map((file) => [path.relative('.', file), file]));

    const existing = await this.pool.query<{ source: string; content_hash: string }>(
      'SELECT source, content_hash FROM doc_sources'
    );
    const existingHashes = new Map(existing.rows.map((r) => [r.source, r.content_hash]));

    const changed: string[] = [];
    const added: string[] = [];
    for (const [source, file] of sources) {
      const hash = this.hashContent(fs.readFileSync(file, 'utf8'));
      const existingHash = existingHashes.get(source);
      if (existingHash === undefined) added.push(source);
      else if (existingHash !== hash) changed.push(source);
    }
    const removed = [...existingHashes.keys()].filter((source) => !sources.has(source));

    if (changed.length === 0 && added.length === 0 && removed.length === 0) return;

    console.warn(
      `[EmbeddingsService] doc_chunks looks out of sync with ${this.docsDir} — run rebuildCache() to fix.` +
        (changed.length ? ` Changed on disk, not yet re-embedded: ${changed.join(', ')}.` : '') +
        (added.length ? ` New on disk, never embedded: ${added.join(', ')}.` : '') +
        (removed.length ? ` No longer on disk, still embedded: ${removed.join(', ')}.` : '')
    );
  }

  /**
   * Hash of a file's raw bytes, used to detect whether a source file has
   * changed since the last rebuild. Salted with CHUNKER_VERSION so that
   * changing how chunkText() splits content also counts as a change, even
   * when the file itself did not — see CHUNKER_VERSION above.
   */
  private hashContent(content: string): string {
    return crypto
      .createHash('sha256')
      .update(`${CHUNKER_VERSION}:${content}`)
      .digest('hex');
  }

  /**
   * Split file content into sections on markdown ATX headers (`#` through
   * `######`), each section starting with its header line and running up
   * to (not including) the next header. Content before the first header,
   * if any, is its own leading section. This keeps a header and the
   * content under it — and a table and its header row — from being
   * separated by chunkText()'s token-window splitting below, which
   * otherwise cuts purely on position with no regard for structure.
   */
  private splitIntoSections(content: string): string[] {
    const lines = content.split('\n');
    const sections: string[] = [];
    let current: string[] = [];
    for (const line of lines) {
      if (/^#{1,6}\s/.test(line) && current.length > 0) {
        sections.push(current.join('\n'));
        current = [line];
      } else {
        current.push(line);
      }
    }
    if (current.length > 0) sections.push(current.join('\n'));
    return sections;
  }

  /**
   * Chunk one file's text into token-sized pieces. First splits on markdown
   * headers (splitIntoSections()) so a header and its content stay
   * together; a section that still exceeds CHUNK_SIZE tokens is then split
   * into overlapping token windows (OVERLAP_TOKENS shared between adjacent
   * windows) so a fact isn't lost purely for landing near a boundary.
   */
  private chunkText(content: string): string[] {
    const stride = CHUNK_SIZE - OVERLAP_TOKENS;
    const chunks: string[] = [];
    for (const section of this.splitIntoSections(content)) {
      const tokens = encode(section);
      if (tokens.length === 0) continue;
      if (tokens.length <= CHUNK_SIZE) {
        chunks.push(decode(tokens));
        continue;
      }
      for (let i = 0; i < tokens.length; i += stride) {
        const end = Math.min(i + CHUNK_SIZE, tokens.length);
        chunks.push(decode(tokens.slice(i, end)));
        if (end === tokens.length) break;
      }
    }
    return chunks;
  }

  /**
   * Re-embed and upsert one changed (or new) source file's chunks,
   * replacing whatever chunks it had before.
   */
  private async upsertSource(source: string, content: string, hash: string): Promise<void> {
    const chunkTexts = this.chunkText(content);
    const embeddings = await this.embedTexts(chunkTexts);

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO doc_sources (source, content_hash, updated_at) VALUES ($1, $2, now())
         ON CONFLICT (source) DO UPDATE SET content_hash = $2, updated_at = now()`,
        [source, hash]
      );
      await client.query('DELETE FROM doc_chunks WHERE source = $1', [source]);
      for (let i = 0; i < chunkTexts.length; i++) {
        await client.query(
          `INSERT INTO doc_chunks (source, chunk_index, content, embedding) VALUES ($1, $2, $3, $4)`,
          [source, i, chunkTexts[i], pgvector.toSql(embeddings[i])]
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Rebuild the embeddings table from the docs directory. Incremental: only
   * files whose content hash changed since the last rebuild are re-chunked
   * and re-embedded; files no longer present on disk have their rows
   * (doc_sources + doc_chunks, via ON DELETE CASCADE) removed.
   */
  async rebuildCache(): Promise<void> {
    const files = this.docsDirExists() ? this.walkFiles(this.docsDir, '.md') : [];
    const sources = new Map(files.map((file) => [path.relative('.', file), file]));

    const existing = await this.pool.query<{ source: string; content_hash: string }>(
      'SELECT source, content_hash FROM doc_sources'
    );
    const existingHashes = new Map(existing.rows.map((r) => [r.source, r.content_hash]));

    for (const [source, file] of sources) {
      const content = fs.readFileSync(file, 'utf8');
      const hash = this.hashContent(content);
      if (existingHashes.get(source) === hash) continue;
      await this.upsertSource(source, content, hash);
    }

    for (const source of existingHashes.keys()) {
      if (!sources.has(source)) {
        await this.pool.query('DELETE FROM doc_sources WHERE source = $1', [source]);
      }
    }
  }

  private docsDirExists(): boolean {
    return fs.existsSync(this.docsDir);
  }

  /**
   * Recursively walk a directory tree to find files with a given extension
   */
  private walkFiles(dir: string, ext: string): string[] {
    let results: string[] = [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        results = results.concat(this.walkFiles(fullPath, ext));
      } else if (entry.isFile() && fullPath.endsWith(ext)) {
        results.push(fullPath);
      }
    }

    return results;
  }

  /**
   * Generate embeddings for an array of text strings
   */
  async embedTexts(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const start = Date.now();

    // Batch into one request per BATCH_SIZE inputs instead of one
    // round-trip per chunk — OpenAI's embeddings endpoint accepts a list of
    // inputs directly. BATCH_SIZE stays comfortably under OpenAI's
    // per-request input limit in case a much larger corpus is ever indexed
    // in one rebuildCache() run.
    const BATCH_SIZE = 500;
    const embeddings: number[][] = [];
    let totalTokens = 0;

    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batch = texts.slice(i, i + BATCH_SIZE);
      const resp = await this.openai.embeddings.create({
        input: batch,
        model: 'text-embedding-3-small'
      });
      totalTokens += resp.usage?.total_tokens ?? 0;
      // Defensive: the API documents results as index-aligned with the
      // input batch, but sort explicitly rather than trust array order.
      for (const item of [...resp.data].sort((a, b) => a.index - b.index)) {
        embeddings.push(item.embedding);
      }
    }

    // Always-on, one-line observability (not gated behind debug, unlike the
    // verbose request/response dumps in llm.ts) — cheap signal for
    // spotting an unexpectedly expensive/slow index or query run without
    // needing a dedicated metrics backend.
    console.log(`[embeddings] texts=${texts.length} tokens=${totalTokens} ms=${Date.now() - start}`);

    return embeddings;
  }

  /**
   * Search for the most relevant chunks given a query embedding
   */
  async search(queryText: string, k: number = 4): Promise<SearchResult[]> {
    if (!this.initialized) {
      throw new Error('Service not initialized. Call initialize() first.');
    }

    const queryEmbeddings = await this.embedTexts([queryText]);
    const queryEmbed = pgvector.toSql(queryEmbeddings[0]);

    // Cosine distance (<=>) ranks nearest first; convert to the same
    // "higher is more similar" score the old in-memory cosine similarity
    // produced, since callers of search() (tests, debugging) expect that.
    const result = await this.pool.query<{ id: string; source: string; content: string; distance: number }>(
      `SELECT id, source, content, embedding <=> $1 AS distance
       FROM doc_chunks
       ORDER BY embedding <=> $1
       LIMIT $2`,
      [queryEmbed, k]
    );

    return result.rows.map((row) => ({
      id: row.id,
      score: 1 - row.distance,
      chunk: { source: row.source, content: row.content }
    }));
  }

  /**
   * Keyword (full-text) search over doc_chunks.content_tsv (see
   * src/db/migrations/005_add_doc_chunks_fts.sql), ranked by ts_rank.
   * Complements search()'s dense cosine similarity: catches exact terms
   * (policy names, dollar amounts, acronyms, codes) that an embedding can
   * dilute into a merely "similar" chunk rather than the right one.
   */
  async keywordSearch(queryText: string, k: number = 4): Promise<SearchResult[]> {
    if (!this.initialized) {
      throw new Error('Service not initialized. Call initialize() first.');
    }

    const result = await this.pool.query<{ id: string; source: string; content: string; rank: number }>(
      `SELECT id, source, content, ts_rank(content_tsv, plainto_tsquery('english', $1)) AS rank
       FROM doc_chunks
       WHERE content_tsv @@ plainto_tsquery('english', $1)
       ORDER BY rank DESC
       LIMIT $2`,
      [queryText, k]
    );

    return result.rows.map((row) => ({
      id: row.id,
      score: row.rank,
      chunk: { source: row.source, content: row.content }
    }));
  }

  /**
   * Reciprocal Rank Fusion: combine two independently-ranked result lists
   * (dense cosine + keyword ts_rank) into one, without needing their raw
   * scores to be on comparable scales — only each list's rank order
   * matters. A chunk absent from one list simply doesn't get that list's
   * term. See RRF_CONSTANT above for the tuning sweep behind its value.
   */
  private fuseRankings(dense: SearchResult[], keyword: SearchResult[], k: number): SearchResult[] {
    const scores = new Map<string, { result: SearchResult; score: number }>();

    const addRanked = (results: SearchResult[]): void => {
      results.forEach((r, index) => {
        const rank = index + 1;
        const entry = scores.get(r.id) ?? { result: r, score: 0 };
        entry.score += 1 / (RRF_CONSTANT + rank);
        scores.set(r.id, entry);
      });
    };
    addRanked(dense);
    addRanked(keyword);

    return Array.from(scores.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map((entry) => entry.result);
  }

  /**
   * Search with multiple query strings and combine results. For each query
   * string, fuses dense (cosine) and keyword (full-text) search via
   * Reciprocal Rank Fusion before deduping across query strings by chunk
   * id — see fuseRankings() and keywordSearch().
   */
  async multiSearch(queries: string[], k: number = 3): Promise<Chunk[]> {
    if (!this.initialized) {
      throw new Error('Service not initialized. Call initialize() first.');
    }

    const seen = new Map<string, Chunk>();
    const candidatePool = k * CANDIDATE_POOL_MULTIPLIER;

    for (const query of queries) {
      const [dense, keyword] = await Promise.all([
        this.search(query, candidatePool),
        this.keywordSearch(query, candidatePool)
      ]);
      const fused = this.fuseRankings(dense, keyword, k);
      fused.forEach((r) => seen.set(r.id, r.chunk));
    }

    return Array.from(seen.values());
  }

  /**
   * Get statistics about the cache
   */
  async getCacheStats(): Promise<{ chunkCount: number; embeddingDim: number }> {
    if (!this.initialized) {
      return { chunkCount: 0, embeddingDim: 0 };
    }

    const result = await this.pool.query<{ count: string }>('SELECT count(*) FROM doc_chunks');
    const chunkCount = Number(result.rows[0].count);
    // Fixed dimension of text-embedding-3-small, the only model this
    // service embeds with — not derived from a stored vector.
    return { chunkCount, embeddingDim: chunkCount > 0 ? 1536 : 0 };
  }
}
