import test from 'node:test';
import assert from 'node:assert/strict';
import type OpenAI from 'openai';
import { RagService } from '../rag/rag.service.js';
import type { EmbeddingsService, Chunk } from '../rag/embeddings.service.js';

function fakeOpenAI(responses: string[]): OpenAI {
  let call = 0;
  return {
    chat: {
      completions: {
        create: () => {
          const content = responses[Math.min(call, responses.length - 1)];
          call++;
          return Promise.resolve({ choices: [{ message: { content } }] });
        }
      }
    }
  } as unknown as OpenAI;
}

function fakeEmbeddingsService(chunks: Chunk[]): EmbeddingsService {
  return { multiSearch: () => Promise.resolve(chunks) } as unknown as EmbeddingsService;
}

test('proposeSearchQueries parses a valid JSON array response', async () => {
  const openai = fakeOpenAI([JSON.stringify(['query one', 'query two'])]);
  const service = new RagService(openai, fakeEmbeddingsService([]));
  const queries = await service.proposeSearchQueries('what is the pto policy');
  assert.deepEqual(queries, ['query one', 'query two']);
});

test('proposeSearchQueries caps at 4 queries first, then drops any blanks within that slice', async () => {
  const openai = fakeOpenAI([JSON.stringify(['a', '', 'b', 'c', 'd', 'e'])]);
  const service = new RagService(openai, fakeEmbeddingsService([]));
  const queries = await service.proposeSearchQueries('question');
  // slice(0, 4) of ['a','','b','c','d','e'] is ['a','','b','c'], then the
  // blank is filtered out — 'd' and 'e' are never reached.
  assert.deepEqual(queries, ['a', 'b', 'c']);
});

test('proposeSearchQueries falls back to splitting the question when the response is not JSON', async () => {
  const openai = fakeOpenAI(['not json at all']);
  const service = new RagService(openai, fakeEmbeddingsService([]));
  const queries = await service.proposeSearchQueries('how many pto days left');
  assert.deepEqual(queries, ['how', 'many', 'pto', 'days']);
});

test('proposeSearchQueries falls back when the JSON is valid but not an array', async () => {
  const openai = fakeOpenAI([JSON.stringify({ not: 'an array' })]);
  const service = new RagService(openai, fakeEmbeddingsService([]));
  const queries = await service.proposeSearchQueries('one two');
  assert.deepEqual(queries, ['one', 'two']);
});

test('proposeSearchQueries falls back to the whole question when it has no words to split', async () => {
  const openai = fakeOpenAI(['[]']); // valid JSON array, but empty -> falls through
  const service = new RagService(openai, fakeEmbeddingsService([]));
  const queries = await service.proposeSearchQueries('   ');
  assert.deepEqual(queries, ['   ']);
});

test('buildContext joins chunks with a Source header', () => {
  const service = new RagService(fakeOpenAI(['[]']), fakeEmbeddingsService([]));
  const context = service.buildContext([
    { source: 'a.md', content: 'Alpha' },
    { source: 'b.md', content: 'Beta' }
  ]);
  assert.equal(context, '### Source: a.md\nAlpha\n### Source: b.md\nBeta');
});

test('searchDocs returns assembled context and source count from the embeddings service', async () => {
  const chunks: Chunk[] = [{ source: 'a.md', content: 'Alpha' }];
  const service = new RagService(fakeOpenAI(['[]']), fakeEmbeddingsService(chunks));
  const { context, sourceCount } = await service.searchDocs(['query']);
  assert.equal(sourceCount, 1);
  assert.equal(context, '### Source: a.md\nAlpha');
});

test('searchDocs counts distinct sources, not chunks (multiple chunks from the same doc count once)', async () => {
  const chunks: Chunk[] = [
    { source: 'a.md', content: 'Alpha 1' },
    { source: 'a.md', content: 'Alpha 2' },
    { source: 'b.md', content: 'Beta' }
  ];
  const service = new RagService(fakeOpenAI(['[]']), fakeEmbeddingsService(chunks));
  const { sourceCount } = await service.searchDocs(['query']);
  assert.equal(sourceCount, 2); // a.md counted once despite 2 chunks
});

test('answerFromDocs proposes queries, searches, and answers from context', async () => {
  const chunks: Chunk[] = [{ source: 'policy.md', content: '20 days of PTO per year' }];
  const openai = fakeOpenAI([JSON.stringify(['pto policy']), 'You get 20 days of PTO per year.']);
  const service = new RagService(openai, fakeEmbeddingsService(chunks), true); // debug: true for log coverage

  const logged: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logged.push(String(msg));
  let result: { answer: string; sources: string[] };
  try {
    result = await service.answerFromDocs('how much pto do employees get');
  } finally {
    console.log = originalLog;
  }

  assert.equal(result.answer, 'You get 20 days of PTO per year.');
  assert.deepEqual(result.sources, ['policy.md']);
  assert.ok(logged.some((line) => line.includes('Generating search queries')));
  assert.ok(logged.some((line) => line.includes('Searching embeddings')));
  assert.ok(logged.some((line) => line.includes('Found 1 chunks')));
});
