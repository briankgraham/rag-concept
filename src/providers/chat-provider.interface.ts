export interface ToolCallRequest {
  id: string;
  name: string;
  /** Raw JSON string exactly as the model produced it; the caller parses/validates it. */
  arguments: string;
}

export type AssistantMessage = {
  role: 'assistant';
  content: string | null;
  toolCalls?: ToolCallRequest[];
};

export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | AssistantMessage
  | { role: 'tool'; toolCallId: string; content: string };

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the tool's arguments. */
  parameters: Record<string, unknown>;
}

export interface ChatOptions {
  model?: string;
}

/** Text-only messages accepted by complete(). */
export type PlainChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

export interface ChatProvider {
  complete(messages: PlainChatMessage[], options?: ChatOptions): Promise<{ content: string; totalTokens?: number; model: string }>;

  /** One model turn with tools advertised; the model may answer or request tool calls. */
  completeWithTools(
    messages: ChatMessage[],
    tools: ToolSpec[],
    options?: ChatOptions
  ): Promise<{ message: AssistantMessage; totalTokens?: number; model: string }>;
}
