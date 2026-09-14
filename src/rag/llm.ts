import OpenAI from 'openai';

export type Message = { role: 'system' | 'user' | 'assistant'; content: string };

export interface ChatCompletionOptions {
  debug?: boolean;
  model?: string;
}

/**
 * Send a chat completion request to the LLM.
 * Shared by the RAG pipeline, the CLI, and the tool-calling orchestrator.
 */
export async function chatCompletion(
  openai: OpenAI,
  messages: Message[],
  options: ChatCompletionOptions = {}
): Promise<string> {
  const { debug = false, model = 'gpt-5' } = options;

  if (debug) {
    console.log('\n[DEBUG] LLM Request:');
    console.log(JSON.stringify({ model, messages }, null, 2));
  }

  const start = Date.now();
  const resp = await openai.chat.completions.create({ model, messages });
  const content = resp.choices[0].message.content || '';

  // Always-on, one-line observability (unlike the verbose debug dumps
  // above) — cost/latency per LLM call was previously invisible outside
  // of --debug runs, on both the RAG and orchestrator paths that share
  // this function.
  console.log(`[llm] model=${model} tokens=${resp.usage?.total_tokens ?? 'n/a'} ms=${Date.now() - start}`);

  if (debug) {
    console.log('\n[DEBUG] LLM Response:');
    console.log(content);
  }

  return content;
}
