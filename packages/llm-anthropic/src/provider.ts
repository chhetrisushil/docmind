import type { LlmProvider, LlmRequest, LlmResponse, LlmStreamChunk } from "@loom/llm";
import {
  LlmAbortedError,
  LlmRefusalError,
  LlmRequestError,
  LlmStreamError,
  LlmUnavailableError,
} from "./errors";
import { type CallObserver, type ReasoningBlock, coversToolUses } from "./observer";
import { EFFORTS, type Effort, toMessagesBody, toolUseGroups } from "./request";
import { parseResponse } from "./response";
import { readSse } from "./sse";
import { StreamState } from "./streamState";

const TRANSIENT = new Set([408, 409, 429, 529]);
const DEFAULT_BASE = "https://api.anthropic.com";
const DEFAULT_MAX_RESPONSE = 4 * 1024 * 1024;
const DEFAULT_MAX_STREAM = 8 * 1024 * 1024;
const MAX_EVENT = 1024 * 1024;
const BAD_KEY = "apiKey must be a header-safe string";
const BAD_BASE = "baseUrl must be an http(s) URL without credentials, query or fragment";

export interface AnthropicOptions {
  apiKey: string;
  model: string;
  maxTokens: number;
  /** Bounds the whole response, streamed or not. */
  timeoutMs: number;
  baseUrl?: string;
  fetch?: typeof fetch;
  maxResponseBytes?: number;
  /** Adaptive thinking with summarized display; never sends `temperature`. Default false. */
  thinking?: boolean;
  /** Sent as `output_config.effort` only when set. */
  effort?: Effort;
  /** Cache breakpoints on the system block and the last block of the last message. Default false. */
  cache?: boolean;
  /** `"report"` hands a refusal to the observer and ends the turn normally; it needs an observer. Default `"throw"`. */
  refusal?: "throw" | "report";
  /** Called once per request. Ingest passes none. */
  observer?: () => CallObserver | undefined;
  /** Byte cap for one response stream. Default 8 MiB. */
  maxStreamBytes?: number;
}

function checkedBase(raw: string): string {
  if (/[?#]/.test(raw)) throw new TypeError(BAD_BASE);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new TypeError(BAD_BASE);
  }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new TypeError(BAD_BASE);
  }
  return url.href.replace(/\/+$/, "");
}

/**
 * Claude over the Messages API (M3b D6; M4 adds streaming, tools, thinking and caching). Errors are
 * typed and carry at most an HTTP status: never the body, the prompt or the key. The response is
 * read with a byte cap. Redirects are not followed.
 */
export class AnthropicMessagesProvider implements LlmProvider {
  readonly capabilities = {
    image: ["image/jpeg", "image/png", "image/gif", "image/webp"],
    file: ["application/pdf"],
  };
  readonly model: string;
  private readonly base: string;
  /** Private (not an enumerable property) so logging or diffing the provider never prints it. */
  readonly #apiKey: string;
  private readonly o: Omit<AnthropicOptions, "apiKey">;

  constructor({ apiKey, ...o }: AnthropicOptions) {
    if (typeof apiKey !== "string" || !/^[\x21-\x7e]+$/.test(apiKey)) {
      throw new TypeError(BAD_KEY);
    }
    this.#apiKey = apiKey;
    this.o = o;
    if (!Number.isSafeInteger(o.maxTokens) || o.maxTokens < 1) {
      throw new RangeError("maxTokens must be a positive integer");
    }
    if (!Number.isSafeInteger(o.timeoutMs) || o.timeoutMs < 1) {
      throw new RangeError("timeoutMs must be a positive integer");
    }
    if (o.effort !== undefined && !EFFORTS.includes(o.effort)) {
      throw new RangeError("effort must be one of low, medium, high, max");
    }
    if (o.refusal === "report" && o.observer === undefined) {
      throw new TypeError('refusal "report" needs an observer');
    }
    if (
      o.maxStreamBytes !== undefined &&
      (!Number.isSafeInteger(o.maxStreamBytes) || o.maxStreamBytes < 1)
    ) {
      throw new RangeError("maxStreamBytes must be a positive integer");
    }
    this.model = o.model;
    this.base = checkedBase(o.baseUrl ?? DEFAULT_BASE);
  }

  /** The request body as JSON. Reasoning blocks come from the observer, and only when thinking is on. */
  async #body(
    request: LlmRequest,
    observer: CallObserver | undefined,
    stream: boolean,
  ): Promise<string> {
    const reasoning = new Map<number, readonly ReasoningBlock[]>();
    if (this.o.thinking === true && observer) {
      for (const { index, ids } of toolUseGroups(request)) {
        const found = await observer.blocksFor(ids);
        if (coversToolUses(ids, found)) reasoning.set(index, found);
      }
    }
    return JSON.stringify(
      toMessagesBody(request, this.model, this.o.maxTokens, {
        thinking: this.o.thinking === true,
        ...(this.o.effort !== undefined && { effort: this.o.effort }),
        cache: this.o.cache === true,
        stream,
        reasoning,
      }),
    );
  }

  /** Sends the request. A non-2xx status releases the body and throws its typed error. */
  async #open(
    request: LlmRequest,
    body: string,
  ): Promise<{ res: Response; signal: AbortSignal; timeout: AbortSignal }> {
    const timeout = AbortSignal.timeout(this.o.timeoutMs);
    const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await (this.o.fetch ?? fetch)(`${this.base}/v1/messages`, {
        method: "POST",
        redirect: "manual",
        signal,
        headers: {
          "content-type": "application/json",
          "x-api-key": this.#apiKey,
          "anthropic-version": "2023-06-01",
        },
        body,
      });
    } catch {
      if (request.signal?.aborted) throw new LlmAbortedError();
      throw new LlmUnavailableError(); // network failure or our own timeout
    }
    if (res.status >= 300) {
      await res.body?.cancel().catch(() => {}); // release the socket on every path
      if (res.status >= 500 || TRANSIENT.has(res.status)) throw new LlmUnavailableError(res.status);
      throw new LlmRequestError(res.status); // 3xx (not followed) and other 4xx
    }
    return { res, signal, timeout };
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const observer = this.o.observer?.();
    const body = await this.#body(request, observer, false);
    const { res, timeout } = await this.#open(request, body);
    try {
      const text = await readCapped(res, this.o.maxResponseBytes ?? DEFAULT_MAX_RESPONSE);
      const parsed = parseResponse(text);
      if (parsed.stop_reason === "refusal") throw new LlmRefusalError();
      return {
        content: parsed.content
          .filter((b) => b.type === "text")
          .map((b) => b.text ?? "")
          .join(""),
        stopReason: parsed.stop_reason === "max_tokens" ? "max_tokens" : "end_turn",
        ...(parsed.usage && {
          usage: {
            inputTokens: parsed.usage.input_tokens,
            outputTokens: parsed.usage.output_tokens,
          },
        }),
      };
    } catch (err) {
      if (request.signal?.aborted) throw new LlmAbortedError();
      if (timeout.aborted) throw new LlmUnavailableError();
      throw err;
    } finally {
      await res.body?.cancel().catch(() => {}); // release the socket on every path
    }
  }

  async *stream(request: LlmRequest): AsyncIterable<LlmStreamChunk> {
    const observer = this.o.observer?.();
    const body = await this.#body(request, observer, true);
    const { res, signal, timeout } = await this.#open(request, body);
    const state = new StreamState((text) => observer?.onThinking(text));
    const max = this.o.maxStreamBytes ?? DEFAULT_MAX_STREAM;
    try {
      if (!res.body) throw new LlmRequestError();
      const caps = { maxEventBytes: Math.min(max, MAX_EVENT), maxTotalBytes: max };
      for await (const ev of readSse(res.body, caps, signal)) {
        for (const chunk of state.feed(ev.event, ev.data)) yield chunk;
        if (state.stopped) break;
      }
      const end = state.end();
      yield {
        delta: "",
        done: true,
        ...(end.toolCalls.length > 0 && { toolCalls: end.toolCalls }),
        stopReason: end.stopReason,
        ...(end.usage && { usage: end.usage }),
      };
    } catch (err) {
      if (request.signal?.aborted) throw new LlmAbortedError();
      if (timeout.aborted) throw new LlmStreamError();
      throw err;
    } finally {
      await res.body?.cancel().catch(() => {}); // a locked body rejects: readSse already cancelled it
    }
  }
}

/** Reads the body up to `max` bytes; a longer body is cancelled, never buffered whole. */
async function readCapped(res: Response, max: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) throw new LlmRequestError();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel().catch(() => {});
        throw new LlmRequestError();
      }
      chunks.push(value);
    }
  } catch (err) {
    if (err instanceof LlmRequestError) throw err;
    throw new LlmUnavailableError(); // the connection broke or timed out mid-body
  } finally {
    // The reader locks the stream, so the caller's res.body.cancel() cannot release it.
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).toString("utf8");
}
