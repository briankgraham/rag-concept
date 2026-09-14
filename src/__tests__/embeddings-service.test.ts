import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type OpenAI from 'openai';
import { pool } from '../db/pool.js';
import { EmbeddingsService } from '../rag/embeddings.service.js';

/*
 * These tests exercise the real Postgres-backed embeddings store (pgvector)
 * — they need DATABASE_URL reachable (see docker-compose.yml) with
 * migrations applied (`npm run migrate`), per the DB exception noted in
 * CONTRIBUTING.md.
 */

const EMBEDDING_DIM = 1536;

// Builds a valid vector(1536) embedding with 1s at the given indices and 0s
// elsewhere — lets tests control cosine similarity precisely without ever
// using an all-zero vector (pgvector's cosine op rejects zero-norm vectors).
function vec(...indices: number[]): number[] {
  const v = new Array(EMBEDDING_DIM).fill(0);
  for (const i of indices) v[i] = 1;
  return v;
}

function fakeOpenAI(vectorFor: (text: string) => number[], onCall?: (text: string) => void): OpenAI {
  return {
    embeddings: {
      create: ({ input }: { input: string[] }) => {
        input.forEach((text) => onCall?.(text));
        return Promise.resolve({
          data: input.map((text, index) => ({ index, embedding: vectorFor(text) }))
        });
      }
    }
  } as unknown as OpenAI;
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'embeddings-test-'));
}

beforeEach(async () => {
  await pool.query('TRUNCATE doc_chunks, doc_sources CASCADE');
});

after(async () => {
  await pool.end();
});

test('rebuildCache chunks markdown files (recursively), skips non-.md files, and stores them in Postgres', async () => {
  const docsDir = tmpDir();
  fs.mkdirSync(path.join(docsDir, 'nested'));

  fs.writeFileSync(path.join(docsDir, 'short.md'), 'short content');
  fs.writeFileSync(path.join(docsDir, 'ignored.txt'), 'should not be picked up');
  // Chunking is by token count (CHUNK_SIZE = 400 tokens), not characters —
  // 300 distinct words tokenizes to ~600 tokens, comfortably over one
  // chunk's worth, so this file splits into 2 chunks. A long run of a
  // single repeated character (e.g. 'x'.repeat(500)) would NOT do this:
  // BPE compresses repeated characters into far fewer tokens than its
  // character count suggests.
  fs.writeFileSync(
    path.join(docsDir, 'nested', 'long.md'),
    Array.from({ length: 300 }, (_, i) => `word${i}`).join(' ')
  );

  const calls: string[] = [];
  const openai = fakeOpenAI(
    () => vec(0),
    (text) => calls.push(text)
  );
  const service = new EmbeddingsService(openai, docsDir, pool);

  await service.rebuildCache();

  assert.equal(calls.length, 3); // 1 chunk from short.md + 2 chunks from long.md

  await service.initialize(); // table already has rows, so this won't re-embed
  assert.equal(calls.length, 3);
  assert.equal((await service.getCacheStats()).chunkCount, 3);
});

test('chunkText keeps each markdown header together with its own content, in a separate chunk', async () => {
  const docsDir = tmpDir();
  fs.writeFileSync(
    path.join(docsDir, 'sections.md'),
    '## Section A\nContent for section A.\n## Section B\nContent for section B.\n'
  );

  const service = new EmbeddingsService(fakeOpenAI(() => vec(0)), docsDir, pool);
  await service.rebuildCache();

  const rows = await pool.query<{ content: string }>(
    'SELECT content FROM doc_chunks ORDER BY chunk_index'
  );
  assert.equal(rows.rows.length, 2); // one chunk per header section, not one blind window
  assert.ok(rows.rows[0].content.startsWith('## Section A'));
  assert.ok(rows.rows[0].content.includes('Content for section A.'));
  assert.ok(rows.rows[1].content.startsWith('## Section B'));
  assert.ok(rows.rows[1].content.includes('Content for section B.'));
});

test('chunkText splits an oversized section into overlapping token windows', async () => {
  const docsDir = tmpDir();
  // Headerless, so this is a single section. 300 zero-padded, distinct
  // words tokenizes to exactly 2 tokens each (600 tokens total, verified
  // against cl100k_base) — comfortably over one 400-token window, forcing
  // a second, overlapping one, with word boundaries landing predictably on
  // token boundaries. (Unpadded numbers, or a single repeated character
  // like 'x'.repeat(n), tokenize unevenly/compress under BPE and would not
  // give predictable word<->token positions.)
  const words = Array.from({ length: 300 }, (_, i) => `word${String(i).padStart(3, '0')}`);
  fs.writeFileSync(path.join(docsDir, 'long.md'), words.join(' '));

  const service = new EmbeddingsService(fakeOpenAI(() => vec(0)), docsDir, pool);
  await service.rebuildCache();

  const rows = await pool.query<{ content: string }>(
    'SELECT content FROM doc_chunks ORDER BY chunk_index'
  );
  assert.equal(rows.rows.length, 2);
  // Window 0 is tokens [0,400) = word000..word199; window 1 is tokens
  // [340,600) = word170..word299 (stride = 400 - 60 overlap tokens, and
  // each word is 2 tokens) — so word170..word199 (the overlapping 60-token
  // span) must appear in both chunks, at the tail of chunk 0 and the head
  // of chunk 1.
  assert.ok(rows.rows[0].content.startsWith('word000'));
  assert.ok(rows.rows[0].content.trimEnd().endsWith('word199'));
  assert.ok(rows.rows[1].content.trimStart().startsWith('word170'));
  assert.ok(rows.rows[1].content.trimEnd().endsWith('word299'));
  assert.ok(rows.rows[0].content.includes('word170')); // start of the overlap
  assert.ok(rows.rows[1].content.includes('word199')); // end of the overlap
});

test('rebuildCache is a no-op (no OpenAI calls) when a file has not changed since the last rebuild', async () => {
  const docsDir = tmpDir();
  fs.writeFileSync(path.join(docsDir, 'a.md'), 'hello world');

  let calls = 0;
  const openai = fakeOpenAI(
    () => vec(0),
    () => calls++
  );
  const service = new EmbeddingsService(openai, docsDir, pool);

  await service.rebuildCache();
  assert.equal(calls, 1);

  await service.rebuildCache(); // same content, same hash
  assert.equal(calls, 1); // no re-embedding
});

test('rebuildCache re-embeds only a changed file, and removes rows for a deleted file', async () => {
  const docsDir = tmpDir();
  const fileA = path.join(docsDir, 'a.md');
  const fileB = path.join(docsDir, 'b.md');
  fs.writeFileSync(fileA, 'aaa');
  fs.writeFileSync(fileB, 'bbb');

  const calls: string[] = [];
  const openai = fakeOpenAI(
    () => vec(0),
    (text) => calls.push(text)
  );
  const service = new EmbeddingsService(openai, docsDir, pool);

  await service.rebuildCache();
  assert.equal(calls.length, 2);

  // Change b.md, delete a.md
  fs.writeFileSync(fileB, 'bbb-changed');
  fs.rmSync(fileA);
  await service.rebuildCache();

  assert.equal(calls.length, 3); // only b.md re-embedded

  const sources = await pool.query('SELECT source FROM doc_sources ORDER BY source');
  assert.deepEqual(
    sources.rows.map((r) => r.source),
    [path.relative('.', fileB)]
  );
});

test('rebuildCache rolls back a source upsert entirely if an embedding fails to insert', async () => {
  const docsDir = tmpDir();
  fs.writeFileSync(path.join(docsDir, 'bad.md'), 'bad content');

  // Wrong dimension -> the INSERT into doc_chunks (vector(1536)) fails,
  // which should roll back the doc_sources upsert in the same transaction.
  const openai = fakeOpenAI(() => [1, 2, 3]);
  const service = new EmbeddingsService(openai, docsDir, pool);

  await assert.rejects(() => service.rebuildCache());

  const sources = await pool.query('SELECT * FROM doc_sources');
  assert.equal(sources.rows.length, 0); // rolled back, not left half-written
});

test('rebuildCache handles a file with no content (zero chunks) without calling OpenAI for it', async () => {
  const docsDir = tmpDir();
  fs.writeFileSync(path.join(docsDir, 'empty.md'), '');

  let calls = 0;
  const service = new EmbeddingsService(fakeOpenAI(() => vec(0), () => calls++), docsDir, pool);
  await service.rebuildCache();

  assert.equal(calls, 0);
  const sources = await pool.query('SELECT source FROM doc_sources');
  assert.equal(sources.rows.length, 1); // the (empty) source is still tracked, just with no chunks
});

test('rebuildCache stores no chunks when the docs directory does not exist', async () => {
  const docsDir = path.join(tmpDir(), 'does-not-exist');
  const openai = fakeOpenAI(() => vec(0));
  const service = new EmbeddingsService(openai, docsDir, pool);

  await service.rebuildCache();
  await service.initialize();
  const stats = await service.getCacheStats();
  assert.equal(stats.chunkCount, 0);
  assert.equal(stats.embeddingDim, 0); // exercises the chunkCount === 0 branch after initialization
});

test('initialize() rebuilds when doc_chunks is empty', async () => {
  const docsDir = tmpDir();
  fs.writeFileSync(path.join(docsDir, 'a.md'), 'hello world');

  let embedCalled = false;
  const openai = fakeOpenAI(() => {
    embedCalled = true;
    return vec(0);
  });
  const service = new EmbeddingsService(openai, docsDir, pool);
  await service.initialize();

  assert.equal(embedCalled, true);
  assert.equal((await service.getCacheStats()).chunkCount, 1);
});

test('initialize() uses existing rows instead of rebuilding when doc_chunks is already populated', async () => {
  const docsDir = tmpDir();
  fs.writeFileSync(path.join(docsDir, 'a.md'), 'hello world');
  const seedService = new EmbeddingsService(
    fakeOpenAI(() => vec(0)),
    docsDir,
    pool
  );
  await seedService.rebuildCache();

  let embedCalled = false;
  const openai = fakeOpenAI(() => {
    embedCalled = true;
    return vec(0);
  });
  const service = new EmbeddingsService(openai, docsDir, pool);
  await service.initialize();

  assert.equal(embedCalled, false); // table already had rows, never re-embedded
  assert.equal((await service.getCacheStats()).chunkCount, 1);
});

test('search() throws if called before initialize()', async () => {
  const service = new EmbeddingsService(
    fakeOpenAI(() => vec(0)),
    tmpDir(),
    pool
  );
  await assert.rejects(() => service.search('anything'), /not initialized/i);
});

test('multiSearch() throws if called before initialize()', async () => {
  const service = new EmbeddingsService(
    fakeOpenAI(() => vec(0)),
    tmpDir(),
    pool
  );
  await assert.rejects(() => service.multiSearch(['anything']), /not initialized/i);
});

test('search() ranks chunks by cosine similarity', async () => {
  const docsDir = tmpDir();
  fs.writeFileSync(path.join(docsDir, 'apple.md'), 'apple');
  fs.writeFileSync(path.join(docsDir, 'banana.md'), 'banana');

  const vectorFor = (text: string): number[] => {
    if (text === 'apple') return vec(0);
    if (text === 'banana') return vec(1);
    return vec(0, 1); // query vector
  };
  const service = new EmbeddingsService(fakeOpenAI(vectorFor), docsDir, pool);
  await service.initialize();

  const results = await service.search('query-for-apple-ish', 2);
  assert.equal(results.length, 2);
  // apple and banana are equidistant (cosine) from the query -> both tie for top rank
  const sources = results.map((r) => r.chunk.source).sort();
  assert.deepEqual(
    sources,
    [
      path.relative('.', path.join(docsDir, 'apple.md')),
      path.relative('.', path.join(docsDir, 'banana.md'))
    ].sort()
  );
});

test('multiSearch() dedupes chunks across overlapping queries', async () => {
  const docsDir = tmpDir();
  fs.writeFileSync(path.join(docsDir, 'a.md'), 'a');
  fs.writeFileSync(path.join(docsDir, 'b.md'), 'b');

  const service = new EmbeddingsService(
    fakeOpenAI(() => vec(0)),
    docsDir,
    pool
  ); // every embedding identical -> every search returns both chunks
  await service.initialize();

  const results = await service.multiSearch(['query one', 'query two'], 2);
  assert.equal(results.length, 2); // deduped, not 4
});

test('keywordSearch() finds a chunk by exact term even with a dissimilar embedding', async () => {
  const docsDir = tmpDir();
  fs.writeFileSync(path.join(docsDir, 'policy.md'), 'The coworking reimbursement cap is $250 per month.');
  fs.writeFileSync(path.join(docsDir, 'unrelated.md'), 'Unrelated content about something else entirely.');

  // Every chunk gets the same embedding, so dense search alone can't
  // distinguish them — keywordSearch() has to be doing its own thing.
  const service = new EmbeddingsService(fakeOpenAI(() => vec(0)), docsDir, pool);
  await service.initialize();

  const results = await service.keywordSearch('coworking reimbursement', 5);
  assert.equal(results.length, 1);
  assert.equal(results[0].chunk.source, path.relative('.', path.join(docsDir, 'policy.md')));
});

test('keywordSearch() throws if called before initialize()', async () => {
  const service = new EmbeddingsService(
    fakeOpenAI(() => vec(0)),
    tmpDir(),
    pool
  );
  await assert.rejects(() => service.keywordSearch('anything'), /not initialized/i);
});

test('multiSearch() surfaces an exact-term match that dense search alone ranks last', async () => {
  const docsDir = tmpDir();
  fs.writeFileSync(path.join(docsDir, 'policy.md'), 'The coworking reimbursement cap is $250 per month.');
  fs.writeFileSync(path.join(docsDir, 'decoy-a.md'), 'decoy a');
  fs.writeFileSync(path.join(docsDir, 'decoy-b.md'), 'decoy b');
  fs.writeFileSync(path.join(docsDir, 'decoy-c.md'), 'decoy c');

  // policy.md's embedding is deliberately the worst cosine match (vec(1)
  // vs. the query's vec(0)) while the three decoys are the best — without
  // fusing in keyword search, a k=1 dense-only search would never surface
  // policy.md at all.
  const vectorFor = (text: string): number[] => {
    if (text.includes('coworking')) return vec(1);
    if (text.startsWith('decoy')) return vec(0);
    return vec(0); // query embedding
  };
  const service = new EmbeddingsService(fakeOpenAI(vectorFor), docsDir, pool);
  await service.initialize();

  const results = await service.multiSearch(['coworking reimbursement cap'], 1);
  assert.equal(results.length, 1);
  assert.equal(results[0].source, path.relative('.', path.join(docsDir, 'policy.md')));
});

test('getCacheStats() returns zeros before initialization', async () => {
  const service = new EmbeddingsService(
    fakeOpenAI(() => vec(0)),
    tmpDir(),
    pool
  );
  assert.deepEqual(await service.getCacheStats(), { chunkCount: 0, embeddingDim: 0 });
});
