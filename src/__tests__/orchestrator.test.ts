import test from 'node:test';
import assert from 'node:assert/strict';
import { runOrchestrator } from '../orchestrator/orchestrator.js';
import type { RagService } from '../rag/rag.service.js';
import type { PtoService } from '../hr/pto.service.js';
import { toolCallMessage, finalMessage, scriptedOpenAI, fakeToolContext } from './test-helpers.js';

test('runOrchestrator executes a tool call and returns the final message', async () => {
  const openai = scriptedOpenAI([
    toolCallMessage('call_1', 'search_company_docs', { queries: ['remote work policy'] }),
    finalMessage('Employees may work remotely up to 3 days a week.')
  ]);

  const ragService: Partial<RagService> = {
    searchDocs: (queries: string[]) => {
      assert.deepEqual(queries, ['remote work policy']);
      return Promise.resolve({
        context: '### Source: 07_remote_work_policy.md\n...',
        sourceCount: 1,
        sources: ['data/company-data/07_remote_work_policy.md']
      });
    }
  };

  const result = await runOrchestrator(
    'what is the remote work policy',
    fakeToolContext(openai, { ragService })
  );

  assert.equal(result.answer, 'Employees may work remotely up to 3 days a week.');
  assert.deepEqual(result.toolCalls, [
    { name: 'search_company_docs', args: { queries: ['remote work policy'] } }
  ]);
  assert.deepEqual(result.retrievedSources, ['data/company-data/07_remote_work_policy.md']);
});

test('runOrchestrator surfaces an unknown tool name as an error and keeps going', async () => {
  const openai = scriptedOpenAI([
    toolCallMessage('call_1', 'not_a_real_tool', {}),
    finalMessage("I couldn't find that information.")
  ]);

  const result = await runOrchestrator('do something unsupported', fakeToolContext(openai));

  assert.equal(result.answer, "I couldn't find that information.");
  assert.deepEqual(result.toolCalls, []); // unknown tool never gets recorded as a successful call
  assert.deepEqual(result.attemptedToolNames, []); // nor as an attempt — there's no real tool to attribute it to
});

test('runOrchestrator surfaces invalid tool arguments as an error and keeps going', async () => {
  const openai = scriptedOpenAI([
    toolCallMessage('call_1', 'search_company_docs', { queries: [] }), // fails min(1)
    finalMessage('Let me know more details.')
  ]);

  const result = await runOrchestrator('vague question', fakeToolContext(openai));

  assert.equal(result.answer, 'Let me know more details.');
  assert.deepEqual(result.toolCalls, []);
});

test('runOrchestrator throws if the model never stops calling tools', async () => {
  const openai = scriptedOpenAI([toolCallMessage('call_1', 'search_company_docs', { queries: ['x'] })]);
  const ragService: Partial<RagService> = {
    searchDocs: () => Promise.resolve({ context: '', sourceCount: 0, sources: [] })
  };

  await assert.rejects(() => runOrchestrator('loop forever', fakeToolContext(openai, { ragService })));
});

test('runOrchestrator logs request/response when debug is true', async () => {
  const openai = scriptedOpenAI([finalMessage('debug answer')]);

  const logged: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logged.push(String(msg));
  let result: Awaited<ReturnType<typeof runOrchestrator>>;
  try {
    result = await runOrchestrator('hello', fakeToolContext(openai, { debug: true }));
  } finally {
    console.log = originalLog;
  }

  assert.equal(result.answer, 'debug answer');
  assert.ok(logged.some((line) => line.includes('Orchestrator turn 1 request')));
  assert.ok(logged.some((line) => line.includes('Orchestrator turn response')));
});

test('runOrchestrator falls back to an empty string when the final message has null content', async () => {
  const openai = scriptedOpenAI([{ role: 'assistant' as const, content: null, tool_calls: undefined }]);
  const result = await runOrchestrator('hello', fakeToolContext(openai));
  assert.equal(result.answer, '');
});

test('runOrchestrator treats empty-string tool arguments as no arguments', async () => {
  const openai = scriptedOpenAI([
    {
      role: 'assistant' as const,
      content: null,
      tool_calls: [
        { id: 'call_1', type: 'function' as const, function: { name: 'get_pto_balance', arguments: '' } }
      ]
    },
    finalMessage('ok')
  ]);
  const result = await runOrchestrator('how many pto days left', fakeToolContext(openai));
  assert.deepEqual(result.toolCalls, [{ name: 'get_pto_balance', args: {} }]);
});

test('runOrchestrator stringifies a non-Error value thrown by a tool', async () => {
  const openai = scriptedOpenAI([toolCallMessage('call_1', 'get_pto_balance', {}), finalMessage('sorry')]);
  const ptoService: Partial<PtoService> = {
    // Deliberately rejecting with a non-Error to exercise orchestrator.ts's
    // `String(err)` branch (the fallback for a caught value that isn't an
    // Error instance) — not a mistake despite what the lint rule assumes.
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    getBalanceForEmployee: () => Promise.reject('boom (not an Error instance)')
  };
  const result = await runOrchestrator('how many pto days left', fakeToolContext(openai, { ptoService }));
  assert.equal(result.answer, 'sorry');
  assert.deepEqual(result.toolCalls, []); // the failed call is never recorded as successful
  // ...but it WAS attempted, which matters for chat.service.ts's source labeling
  // (a failed personal-data lookup shouldn't be mislabeled as a generic "direct" answer).
  assert.deepEqual(result.attemptedToolNames, ['get_pto_balance']);
});

test('runOrchestrator splices prior conversation history between the system prompt and the new question', async () => {
  let capturedMessages: Array<{ role: string; content: unknown }> = [];
  const openai = scriptedOpenAI([finalMessage('follow-up answer')], (request) => {
    // Copy, not just reference: orchestrator.ts mutates its `messages`
    // array in place (pushing the model's reply) after this call, so
    // capturing the reference itself would see that later mutation too.
    capturedMessages = [...(request as { messages: Array<{ role: string; content: unknown }> }).messages];
  });
  const history = [
    { role: 'user' as const, content: 'what is our pto policy' },
    { role: 'assistant' as const, content: 'You get 20 days per year.' }
  ];

  const result = await runOrchestrator('what about carryover', fakeToolContext(openai), history);

  assert.equal(result.answer, 'follow-up answer');
  assert.equal(capturedMessages[0].role, 'system');
  assert.deepEqual(capturedMessages.slice(1, 3), history);
  assert.deepEqual(capturedMessages[3], { role: 'user', content: 'what about carryover' });
});

test('runOrchestrator defaults to no prior history', async () => {
  let capturedMessages: Array<{ role: string; content: unknown }> = [];
  const openai = scriptedOpenAI([finalMessage('hi')], (request) => {
    capturedMessages = [...(request as { messages: Array<{ role: string; content: unknown }> }).messages];
  });

  await runOrchestrator('hello', fakeToolContext(openai));

  assert.equal(capturedMessages.length, 2); // system + this question, no history spliced in
});

test('runOrchestrator dispatches get_pto_balance and relays its preferredAnswer', async () => {
  const openai = scriptedOpenAI([
    toolCallMessage('call_1', 'get_pto_balance', {}),
    finalMessage('You have 10 days of PTO left (accrued 20, used 10, as of 2026-09-13).')
  ]);

  // Uses fakeToolContext's default fake PtoService — no database involved.
  const result = await runOrchestrator('how many pto days do i have left', fakeToolContext(openai));

  assert.deepEqual(result.toolCalls, [{ name: 'get_pto_balance', args: {} }]);
  assert.match(result.answer, /10 days of PTO left/);
});
