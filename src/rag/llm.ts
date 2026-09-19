import type { ChatProvider, PlainChatMessage } from '../providers/chat-provider.interface.js';

export type Message = PlainChatMessage;

export interface ChatCompletionOptions {
  debug?: boolean;
  model?: string;
}

/**
 * Send a chat completion request to the LLM.
 * Shared by the RAG pipeline, the CLI, and the tool-calling orchestrator.
 */
export async function chatCompletion(
  chat: ChatProvider,
  messages: Message[],
  options: ChatCompletionOptions = {}
): Promise<string> {
  const { debug = false, model } = options;

  if (debug) {
    console.log('\n[DEBUG] LLM Request:');
    console.log(JSON.stringify({ model, messages }, null, 2));
  }

  const start = Date.now();
  const { content, totalTokens, model: usedModel } = await chat.complete(messages, { model });

  // Always-on, one-line observability (unlike the verbose debug dumps
  // above) — cost/latency per LLM call was previously invisible outside
  // of --debug runs, on both the RAG and orchestrator paths that share
  // this function.
  console.log(`[llm] model=${usedModel} tokens=${totalTokens ?? 'n/a'} ms=${Date.now() - start}`);

  if (debug) {
    console.log('\n[DEBUG] LLM Response:');
    console.log(content);
  }

  return content;
}
