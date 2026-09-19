import type OpenAI from 'openai';
import type { EmbeddingsProvider, EmbeddingsResult } from '../embeddings-provider.interface.js';

// Stays comfortably under OpenAI's per-request input limit.
const BATCH_SIZE = 500;

export class OpenAiEmbeddingsProvider implements EmbeddingsProvider {
  readonly model = 'text-embedding-3-small';
  readonly dimensions = 1536;

  constructor(private client: OpenAI) {}

  async embed(texts: string[]): Promise<EmbeddingsResult> {
    const vectors: number[][] = [];
    let totalTokens = 0;

    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const resp = await this.client.embeddings.create({
        input: texts.slice(i, i + BATCH_SIZE),
        model: this.model
      });
      totalTokens += resp.usage?.total_tokens ?? 0;
      // The API documents results as index-aligned with the input, but sort explicitly rather than trust array order.
      for (const item of [...resp.data].sort((a, b) => a.index - b.index)) {
        vectors.push(item.embedding);
      }
    }

    return { vectors, totalTokens };
  }
}
