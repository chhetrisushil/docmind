import { type EmbedOptions, EmbeddingError, type EmbeddingProvider } from "@loom/memory";

/** Worth retrying: the service is down, slow or overloaded. Permanent problems are plain EmbeddingError. */
export class EmbeddingUnavailableError extends EmbeddingError {
  constructor() {
    super("the embedding service is unavailable");
    this.name = "EmbeddingUnavailableError";
  }
}

export interface OllamaOptions {
  baseUrl: string;
  model: string;
  dimensions: number;
  maxBatchSize?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_BATCH_SIZE = 64;

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly modelId: string;
  readonly dimensions: number;
  readonly maxBatchSize: number;
  constructor(private readonly options: OllamaOptions) {
    this.modelId = `ollama/${options.model}`;
    this.dimensions = options.dimensions;
    this.maxBatchSize = options.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE;
  }

  async embed(texts: readonly string[], opts: EmbedOptions = {}): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += this.maxBatchSize) {
      out.push(...(await this.request(texts.slice(i, i + this.maxBatchSize), opts.signal)));
    }
    return out;
  }

  private async request(batch: readonly string[], signal?: AbortSignal): Promise<number[][]> {
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const response = await (this.options.fetch ?? fetch)(
      `${this.options.baseUrl.replace(/\/$/, "")}/api/embed`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: this.options.model, input: batch, truncate: true }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      },
    );
    return ((await response.json()) as { embeddings: number[][] }).embeddings;
  }
}
