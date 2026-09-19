import OpenAI from 'openai';
import type { ChatProvider } from '../chat-provider.interface.js';
import type { EmbeddingsProvider } from '../embeddings-provider.interface.js';
import { OpenAiChatProvider } from './openai-chat.provider.js';
import { OpenAiEmbeddingsProvider } from './openai-embeddings.provider.js';

export interface Providers {
  embeddings: EmbeddingsProvider;
  chat: ChatProvider;
}

export function createProviders(apiKey: string): Providers {
  const client = new OpenAI({ apiKey });
  return {
    embeddings: new OpenAiEmbeddingsProvider(client),
    chat: new OpenAiChatProvider(client)
  };
}
