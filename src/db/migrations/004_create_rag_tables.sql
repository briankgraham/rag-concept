CREATE EXTENSION IF NOT EXISTS vector;

-- One row per source markdown file under data/company-data/. content_hash
-- (SHA-256 of the raw file bytes) lets EmbeddingsService.rebuildCache()
-- skip re-embedding files that haven't changed since the last rebuild.
CREATE TABLE doc_sources (
  source        TEXT PRIMARY KEY,
  content_hash  TEXT NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per chunk. embedding dimension (1536) matches OpenAI's
-- text-embedding-3-small, the only embedding model this app uses
-- (see src/rag/embeddings.service.ts).
CREATE TABLE doc_chunks (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source        TEXT NOT NULL REFERENCES doc_sources(source) ON DELETE CASCADE,
  chunk_index   INT NOT NULL,
  content       TEXT NOT NULL,
  embedding     vector(1536) NOT NULL,
  UNIQUE (source, chunk_index)
);

-- HNSW over cosine distance, matching the <=> operator used in
-- EmbeddingsService's search queries.
CREATE INDEX idx_doc_chunks_embedding ON doc_chunks USING hnsw (embedding vector_cosine_ops);
