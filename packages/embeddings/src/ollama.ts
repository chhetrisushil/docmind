import { type EmbedOptions, EmbeddingError, type EmbeddingProvider } from "@loom/memory";
import { z } from "zod";

/** Worth retrying: the service is down, slow or overloaded. Permanent problems are plain EmbeddingError. */
export class EmbeddingUnavailableError extends EmbeddingError {
  constructor() {
    super("the embedding service is unavailable");
    this.name = "EmbeddingUnavailableError";
  }
}

/**
 * The caller's own AbortSignal fired. That is cancellation, not a failure of the service, so it is
 * neither class above: it is not an EmbeddingError, a retry policy must not count or retry it, and
 * a step treats it like Loom's cancel (the run is already being stopped).
 */
export class EmbeddingAbortedError extends Error {
  constructor() {
    super("the embedding request was aborted");
    this.name = "EmbeddingAbortedError";
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

const BAD_URL = "DOCMIND_OLLAMA_URL must be an http(s) URL without credentials, query or fragment";

/** The one URL requests go to: the validated base plus /api/embed, nothing taken from elsewhere. */
function embedUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new EmbeddingError(BAD_URL);
  }
  const http = url.protocol === "http:" || url.protocol === "https:";
  if (!http || url.username || url.password || url.search || url.hash) {
    throw new EmbeddingError(BAD_URL);
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}/api/embed`;
}

const positive = (n: number | undefined, message: string) => {
  if (n !== undefined && !(Number.isInteger(n) && n > 0)) throw new EmbeddingError(message);
};

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_BATCH_SIZE = 64;
/** A JSON double is at most about 25 bytes; the cap allows 32 per expected value plus 64 KiB. */
export const MAX_BYTES_PER_VALUE = 32;
export const MAX_RESPONSE_OVERHEAD_BYTES = 64 * 1024;

const Body = z.object({ embeddings: z.array(z.array(z.number().finite())) });

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly modelId: string;
  readonly dimensions: number;
  readonly maxBatchSize: number;
  private readonly endpoint: string;
  constructor(private readonly options: OllamaOptions) {
    this.endpoint = embedUrl(options.baseUrl);
    positive(options.dimensions, "DOCMIND_EMBED_DIMENSIONS must be a positive integer");
    positive(options.timeoutMs, "DOCMIND_EMBED_TIMEOUT_MS must be a positive integer");
    positive(options.maxBatchSize, "maxBatchSize must be a positive integer");
    this.modelId = `ollama/${options.model}`;
    this.dimensions = options.dimensions;
    this.maxBatchSize = options.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE;
  }

  async embed(texts: readonly string[], opts: EmbedOptions = {}): Promise<number[][]> {
    const out: number[][] = [];
    if (opts.signal?.aborted) throw new EmbeddingAbortedError();
    for (let i = 0; i < texts.length; i += this.maxBatchSize) {
      out.push(...(await this.request(texts.slice(i, i + this.maxBatchSize), opts.signal)));
    }
    return out;
  }

  private failure(signal?: AbortSignal): Error {
    return signal?.aborted ? new EmbeddingAbortedError() : new EmbeddingUnavailableError();
  }

  private async request(batch: readonly string[], signal?: AbortSignal): Promise<number[][]> {
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const merged = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await (this.options.fetch ?? fetch)(this.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: this.options.model, input: batch, truncate: true }),
        redirect: "error", // a hostile redirect must not carry document text elsewhere
        signal: merged,
      });
    } catch {
      throw this.failure(signal); // connection refused, DNS, timeout, caller abort
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {}); // never leave the body open
      if (response.status === 429 || response.status >= 500) throw new EmbeddingUnavailableError();
      throw new EmbeddingError(
        `the embedding service refused the request (HTTP ${response.status})`,
      );
    }
    const max = batch.length * this.dimensions * MAX_BYTES_PER_VALUE + MAX_RESPONSE_OVERHEAD_BYTES;
    const text = await this.readCapped(response, max, signal);
    let embeddings: number[][];
    try {
      embeddings = Body.parse(JSON.parse(text)).embeddings;
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

  /** Reads the body up to `max` bytes; a longer body is cancelled, never buffered whole. */
  private async readCapped(response: Response, max: number, signal?: AbortSignal): Promise<string> {
    const reader = response.body?.getReader();
    if (!reader)
      throw new EmbeddingError("the embedding service answered with an unexpected shape");
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > max) {
          await reader.cancel().catch(() => {});
          throw new EmbeddingError("the embedding service answered with too large a response");
        }
        chunks.push(value);
      }
    } catch (err) {
      if (err instanceof EmbeddingError) throw err;
      throw this.failure(signal); // the connection broke or timed out mid-body
    }
    return Buffer.concat(chunks).toString("utf8");
  }
}
