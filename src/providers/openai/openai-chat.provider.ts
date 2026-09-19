import type OpenAI from 'openai';
import type {
  AssistantMessage,
  ChatMessage,
  ChatOptions,
  ChatProvider,
  PlainChatMessage,
  ToolSpec
} from '../chat-provider.interface.js';

type OpenAiMessage = OpenAI.ChatCompletionMessageParam;

export const DEFAULT_CHAT_MODEL = 'gpt-5';

function toOpenAiMessage(message: ChatMessage): OpenAiMessage {
  switch (message.role) {
    case 'tool':
      return { role: 'tool', tool_call_id: message.toolCallId, content: message.content };
    case 'assistant':
      return {
        role: 'assistant',
        content: message.content,
        ...(message.toolCalls?.length && {
          tool_calls: message.toolCalls.map((call) => ({
            id: call.id,
            type: 'function' as const,
            function: { name: call.name, arguments: call.arguments }
          }))
        })
      };
    default:
      return { role: message.role, content: message.content };
  }
}

export class OpenAiChatProvider implements ChatProvider {
  constructor(
    private client: OpenAI,
    private defaultModel: string = DEFAULT_CHAT_MODEL
  ) {}

  async complete(messages: PlainChatMessage[], options: ChatOptions = {}) {
    const model = options.model ?? this.defaultModel;
    const resp = await this.client.chat.completions.create({ model, messages });
    return {
      content: resp.choices[0].message.content || '',
      totalTokens: resp.usage?.total_tokens,
      model
    };
  }

  async completeWithTools(messages: ChatMessage[], tools: ToolSpec[], options: ChatOptions = {}) {
    const model = options.model ?? this.defaultModel;
    const resp = await this.client.chat.completions.create({
      model,
      messages: messages.map(toOpenAiMessage),
      tools: tools.map((tool) => ({
        type: 'function' as const,
        function: { name: tool.name, description: tool.description, parameters: tool.parameters }
      })),
      tool_choice: 'auto'
    });

    const raw = resp.choices[0].message;
    const message: AssistantMessage = {
      role: 'assistant',
      content: raw.content,
      toolCalls: raw.tool_calls
        ?.filter((call) => call.type === 'function')
        .map((call) => ({ id: call.id, name: call.function.name, arguments: call.function.arguments }))
    };
    return { message, totalTokens: resp.usage?.total_tokens, model };
  }
}
