import test from 'node:test';
import assert from 'node:assert/strict';
import type OpenAI from 'openai';
import { chatCompletion } from '../rag/llm.js';

function fakeOpenAI(content: string, capturedModel: { value?: string } = {}): OpenAI {
  return {
    chat: {
      completions: {
        create: (params: { model: string }) => {
          capturedModel.value = params.model;
          return Promise.resolve({ choices: [{ message: { content } }] });
        }
      }
    }
  } as unknown as OpenAI;
}

test('chatCompletion returns the message content using the default model', async () => {
  const captured: { value?: string } = {};
  const openai = fakeOpenAI('hello', captured);
  const result = await chatCompletion(openai, [{ role: 'user', content: 'hi' }]);
  assert.equal(result, 'hello');
  assert.equal(captured.value, 'gpt-5');
});

test('chatCompletion honors a custom model option', async () => {
  const captured: { value?: string } = {};
  const openai = fakeOpenAI('hi', captured);
  await chatCompletion(openai, [{ role: 'user', content: 'hi' }], { model: 'gpt-4o' });
  assert.equal(captured.value, 'gpt-4o');
});

test('chatCompletion falls back to an empty string when content is null', async () => {
  const openai = {
    chat: { completions: { create: () => Promise.resolve({ choices: [{ message: { content: null } }] }) } }
  } as unknown as OpenAI;
  const result = await chatCompletion(openai, [{ role: 'user', content: 'hi' }]);
  assert.equal(result, '');
});

test('chatCompletion logs request/response when debug is true', async () => {
  const logged: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logged.push(msg);
  try {
    const openai = fakeOpenAI('debug-response');
    await chatCompletion(openai, [{ role: 'user', content: 'hi' }], { debug: true });
  } finally {
    console.log = originalLog;
  }
  assert.ok(logged.some((line) => line.includes('[DEBUG] LLM Request:')));
  assert.ok(logged.some((line) => line.includes('[DEBUG] LLM Response:')));
});
