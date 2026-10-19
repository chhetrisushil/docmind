import { type EmbedOptions, EmbeddingError, type EmbeddingProvider } from "@loom/memory";
import { z } from "zod";

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

const Body = z.object({ embeddings: z.array(z.array(z.number().finite())) });

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
    let response: Response;
    try {
      response = await (this.options.fetch ?? fetch)(
        `${this.options.baseUrl.replace(/\/$/, "")}/api/embed`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: this.options.model, input: batch, truncate: true }),
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        },
      );
    } catch {
      throw new EmbeddingUnavailableError(); // connection refused, DNS, timeout, abort
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {}); // never leave the body open
      if (response.status === 429 || response.status >= 500) throw new EmbeddingUnavailableError();
      throw new EmbeddingError(
        `the embedding service refused the request (HTTP ${response.status})`,
      );
    }
    let embeddings: number[][];
    try {
      embeddings = Body.parse(await response.json()).embeddings;
    } catch {
      throw new EmbeddingError("the embedding service answered with an unexpected shape");
    }
    if (
      embeddings.length !== batch.length ||
      embeddings.some((v) => v.length !== this.dimensions)
    ) {
      throw new EmbeddingError(
        "the embedding service returned the wrong number or size of vectors",
      );
    }
    return embeddings;
  }
}
