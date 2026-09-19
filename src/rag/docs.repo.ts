import type { Pool, PoolClient } from 'pg';
import pgvector from 'pgvector';

/**
 * Raw SQL/transaction logic for doc_sources/doc_chunks (see
 * src/db/migrations/004_create_rag_tables.sql and
 * 005_add_doc_chunks_fts.sql). Every function here takes `pool: Pool`
 * explicitly rather than importing db/pool.ts's query() singleton, because
 * EmbeddingsService (the only caller) takes its Pool via constructor
 * injection rather than the module-level pool — see CONTRIBUTING.md's note
 * on that deliberate departure. pgvector serialization also lives entirely
 * in this file so callers deal only in plain number[]/number[][].
 */

export interface DocSourceHashRow {
  source: string;
  content_hash: string;
}

/**
 * Map of every currently-recorded source path to its stored content_hash.
 * Shared by warnIfStale() (read-only staleness check) and rebuildCache()
 * (actual re-sync) so they don't each run their own near-identical query.
 */
export async function getSourceHashMap(pool: Pool): Promise<Map<string, string>> {
  const result = await pool.query<DocSourceHashRow>('SELECT source, content_hash FROM doc_sources');
  return new Map(result.rows.map((r) => [r.source, r.content_hash]));
}

/**
 * Total row count in doc_chunks. Used by initialize() to decide whether an
 * initial rebuildCache() is needed (empty table) and by getCacheStats().
 */
export async function getChunkCount(pool: Pool): Promise<number> {
  const result = await pool.query<{ count: string }>('SELECT count(*) FROM doc_chunks');
  return Number(result.rows[0].count);
}

/**
 * Replace one source's chunks+embeddings transactionally: upsert its
 * doc_sources row, delete its old doc_chunks, insert the new ones — all in
 * one BEGIN/COMMIT so a failure partway through (e.g. a malformed embedding
 * violating doc_chunks' vector(1536) column) leaves neither a stale
 * doc_sources row nor half-written chunks. pgvector.toSql() serialization
 * happens here, per chunk.
 */
export async function upsertSourceChunks(
  pool: Pool,
  source: string,
  hash: string,
  chunkTexts: string[],
  embeddings: number[][]
): Promise<void> {
  const client: PoolClient = await pool.connect();
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

/** Remove a source (and, via ON DELETE CASCADE, its chunks) no longer on disk. */
export async function deleteSource(pool: Pool, source: string): Promise<void> {
  await pool.query('DELETE FROM doc_sources WHERE source = $1', [source]);
}

export interface VectorSearchRow {
  id: string;
  source: string;
  content: string;
  distance: number;
}

/**
 * Nearest doc_chunks rows to a query embedding, ranked by cosine distance
 * (<=>, pgvector) ascending — nearest first. Serializes queryEmbedding to
 * pgvector's wire format internally so callers pass a plain number[].
 */
export async function vectorSearch(pool: Pool, queryEmbedding: number[], k: number): Promise<VectorSearchRow[]> {
  const result = await pool.query<VectorSearchRow>(
    `SELECT id, source, content, embedding <=> $1 AS distance
     FROM doc_chunks
     ORDER BY embedding <=> $1
     LIMIT $2`,
    [pgvector.toSql(queryEmbedding), k]
  );
  return result.rows;
}

export interface KeywordSearchRow {
  id: string;
  source: string;
  content: string;
  rank: number;
}

/**
 * Full-text search over doc_chunks.content_tsv (see
 * src/db/migrations/005_add_doc_chunks_fts.sql), ranked by ts_rank against a
 * plainto_tsquery built from queryText.
 */
export async function keywordSearchRows(pool: Pool, queryText: string, k: number): Promise<KeywordSearchRow[]> {
  const result = await pool.query<KeywordSearchRow>(
    `SELECT id, source, content, ts_rank(content_tsv, plainto_tsquery('english', $1)) AS rank
     FROM doc_chunks
     WHERE content_tsv @@ plainto_tsquery('english', $1)
     ORDER BY rank DESC
     LIMIT $2`,
    [queryText, k]
  );
  return result.rows;
}
