export interface EmbeddingsResult {
  vectors: number[][];
  totalTokens?: number;
}

/** Turns text into embedding vectors. Implementations own batching and vendor request limits. */
export interface EmbeddingsProvider {
  readonly model: string;
  readonly dimensions: number;
  /** `vectors` must be index-aligned with `texts`. */
  embed(texts: string[]): Promise<EmbeddingsResult>;
}
