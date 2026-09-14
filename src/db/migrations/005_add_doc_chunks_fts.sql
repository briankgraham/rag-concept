-- Generated tsvector column + GIN index, for keyword (full-text) search
-- alongside the existing pgvector cosine search — see
-- EmbeddingsService.keywordSearch()/multiSearch(). STORED means Postgres
-- computes and backfills this column for existing rows automatically on
-- this ALTER, and keeps it in sync on every future INSERT/UPDATE of
-- content — no application-side re-embedding or CHUNKER_VERSION bump
-- needed, since chunk content itself isn't changing.
ALTER TABLE doc_chunks
  ADD COLUMN content_tsv tsvector
  GENERATED ALWAYS AS (to_tsvector('english', content)) STORED;

CREATE INDEX idx_doc_chunks_content_tsv ON doc_chunks USING gin (content_tsv);
