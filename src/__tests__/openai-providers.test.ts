import test from 'node:test';
import assert from 'node:assert/strict';
import type OpenAI from 'openai';
import { OpenAiEmbeddingsProvider } from '../providers/openai/openai-embeddings.provider.js';
import { OpenAiChatProvider } from '../providers/openai/openai-chat.provider.js';

test('embeddings provider batches at 500 inputs, restores index order, and sums usage', async () => {
  const batchSizes: number[] = [];
  const client = {
    embeddings: {
      create: ({ input }: { input: string[] }) => {
        batchSizes.push(input.length);
        return Promise.resolve({
          // Deliberately reversed to prove the provider re-sorts by index.
          data: input.map((text, index) => ({ index, embedding: [Number(text)] })).reverse(),
          usage: { total_tokens: input.length }
        });
      }
    }
  } as unknown as OpenAI;

  const texts = Array.from({ length: 1001 }, (_, i) => String(i));
  const result = await new OpenAiEmbeddingsProvider(client).embed(texts);

  assert.deepEqual(batchSizes, [500, 500, 1]);
  assert.equal(result.vectors.length, 1001);
  assert.deepEqual(result.vectors[0], [0]);
  assert.deepEqual(result.vectors[500], [500]);
  assert.deepEqual(result.vectors[1000], [1000]);
  assert.equal(result.totalTokens, 1001);
});

test('embeddings provider tolerates a response with no usage', async () => {
  const client = {
    embeddings: { create: () => Promise.resolve({ data: [{ index: 0, embedding: [1] }] }) }
  } as unknown as OpenAI;
  const result = await new OpenAiEmbeddingsProvider(client).embed(['a']);
  assert.deepEqual(result.vectors, [[1]]);
  assert.equal(result.totalTokens, 0);
});

function chatClient(message: unknown, captured: { request?: any } = {}): OpenAI {
  return {
    chat: {
      completions: {
        create: (request: unknown) => {
          captured.request = request;
          return Promise.resolve({ choices: [{ message }], usage: { total_tokens: 7 } });
        }
      }
    }
  } as unknown as OpenAI;
}

test('chat provider complete() uses the default model, honors an override, and maps null content to ""', async () => {
  const captured: { request?: any } = {};
  const provider = new OpenAiChatProvider(chatClient({ content: null }, captured));

  const first = await provider.complete([{ role: 'user', content: 'hi' }]);
  assert.equal(captured.request.model, 'gpt-5');
  assert.equal(first.model, 'gpt-5');
  assert.equal(first.content, '');
  assert.equal(first.totalTokens, 7);

  await provider.complete([{ role: 'user', content: 'hi' }], { model: 'gpt-4o' });
  assert.equal(captured.request.model, 'gpt-4o');
});

test('chat provider completeWithTools() maps neutral messages/tools to the OpenAI shape and back', async () => {
  const captured: { request?: any } = {};
  const provider = new OpenAiChatProvider(
    chatClient(
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_pto_balance', arguments: '{}' } }]
      },
      captured
    )
  );

  const { message } = await provider.completeWithTools(
    [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'q' },
      { role: 'assistant', content: null, toolCalls: [{ id: 'p1', name: 'x', arguments: '{"a":1}' }] },
      { role: 'tool', toolCallId: 'p1', content: '{"ok":true}' }
    ],
    [{ name: 'get_pto_balance', description: 'd', parameters: { type: 'object' } }]
  );

  assert.deepEqual(captured.request.messages, [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'q' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'p1', type: 'function', function: { name: 'x', arguments: '{"a":1}' } }]
    },
    { role: 'tool', tool_call_id: 'p1', content: '{"ok":true}' }
  ]);
  assert.deepEqual(captured.request.tools, [
    { type: 'function', function: { name: 'get_pto_balance', description: 'd', parameters: { type: 'object' } } }
  ]);
  assert.equal(captured.request.tool_choice, 'auto');
  assert.deepEqual(message, {
    role: 'assistant',
    content: null,
    toolCalls: [{ id: 'c1', name: 'get_pto_balance', arguments: '{}' }]
  });
});

test('chat provider completeWithTools() returns no toolCalls for a plain answer', async () => {
  const provider = new OpenAiChatProvider(chatClient({ role: 'assistant', content: 'done' }));
  const { message } = await provider.completeWithTools([{ role: 'user', content: 'q' }], []);
  assert.equal(message.content, 'done');
  assert.equal(message.toolCalls, undefined);
});
