import test from 'node:test';
import assert from 'node:assert/strict';
import type { ChatProvider } from '../providers/chat-provider.interface.js';
import { chatCompletion } from '../rag/llm.js';

function fakeChat(content: string | null, captured: { model?: string } = {}): ChatProvider {
  return {
    complete: (_messages, options) => {
      captured.model = options?.model;
      return Promise.resolve({ content: content ?? '', model: options?.model ?? 'default-model' });
    },
    completeWithTools: () => Promise.reject(new Error('not used'))
  };
}

test('chatCompletion returns the message content and lets the provider choose the default model', async () => {
  const captured: { model?: string } = {};
  const result = await chatCompletion(fakeChat('hello', captured), [{ role: 'user', content: 'hi' }]);
  assert.equal(result, 'hello');
  assert.equal(captured.model, undefined);
});

test('chatCompletion forwards a custom model option to the provider', async () => {
  const captured: { model?: string } = {};
  await chatCompletion(fakeChat('hi', captured), [{ role: 'user', content: 'hi' }], { model: 'gpt-4o' });
  assert.equal(captured.model, 'gpt-4o');
});

test('chatCompletion logs request/response when debug is true', async () => {
  const logged: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logged.push(msg);
  try {
    await chatCompletion(fakeChat('debug-response'), [{ role: 'user', content: 'hi' }], { debug: true });
  } finally {
    console.log = originalLog;
  }
  assert.ok(logged.some((line) => line.includes('[DEBUG] LLM Request:')));
  assert.ok(logged.some((line) => line.includes('[DEBUG] LLM Response:')));
});
