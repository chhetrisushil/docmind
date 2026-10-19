import type { LlmProvider, LlmRequest, LlmResponse } from "@loom/llm";
import { LlmAbortedError, LlmRefusalError, LlmRequestError, LlmUnavailableError } from "./errors";
import { toMessagesBody } from "./request";

const TRANSIENT = new Set([408, 409, 429, 529]);
const DEFAULT_BASE = "https://api.anthropic.com";
const DEFAULT_MAX_RESPONSE = 4 * 1024 * 1024;
const BAD_BASE = "baseUrl must be an http(s) URL without credentials, query or fragment";

export interface AnthropicOptions {
  apiKey: string;
  model: string;
  maxTokens: number;
  timeoutMs: number;
  baseUrl?: string;
  fetch?: typeof fetch;
  maxResponseBytes?: number;
}

function checkedBase(raw: string): string {
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

interface Parsed {
  content: { type: string; text?: string }[];
  stop_reason: string;
  usage?: { input_tokens: number; output_tokens: number };
}

const count = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0;

/** Validates the response by hand. Never puts the text in an error. */
function parseResponse(text: string): Parsed {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new LlmRequestError();
  }
  const o = raw as Record<string, unknown> | null;
  if (typeof o !== "object" || o === null) throw new LlmRequestError();
  const { content, stop_reason: stop, usage } = o;
  if (
    !Array.isArray(content) ||
    typeof stop !== "string" ||
    !content.every(
      (b) =>
        typeof b === "object" &&
        b !== null &&
        typeof b.type === "string" &&
        (b.text === undefined || typeof b.text === "string"),
    )
  ) {
    throw new LlmRequestError();
  }
  if (usage !== undefined) {
    const u = usage as Record<string, unknown> | null;
    if (typeof u !== "object" || u === null || !count(u.input_tokens) || !count(u.output_tokens)) {
      throw new LlmRequestError();
    }
  }
  return o as unknown as Parsed;
}

/**
 * Claude over the Messages API, non-streaming (M3b D6; M4 adds streaming and thinking). Errors are
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

  constructor(private readonly o: AnthropicOptions) {
    if (!o.apiKey) throw new TypeError("apiKey must be set");
    if (!Number.isSafeInteger(o.maxTokens) || o.maxTokens < 1) {
      throw new RangeError("maxTokens must be a positive integer");
    }
    if (!Number.isSafeInteger(o.timeoutMs) || o.timeoutMs < 1) {
      throw new RangeError("timeoutMs must be a positive integer");
    }
    this.model = o.model;
    this.base = checkedBase(o.baseUrl ?? DEFAULT_BASE);
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const body = JSON.stringify(toMessagesBody(request, this.model, this.o.maxTokens));
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
          "x-api-key": this.o.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body,
      });
    } catch {
      if (request.signal?.aborted) throw new LlmAbortedError();
      throw new LlmUnavailableError(); // network failure or our own timeout
    }
    try {
      if (res.status >= 300) {
        if (res.status >= 500 || TRANSIENT.has(res.status))
          throw new LlmUnavailableError(res.status);
        throw new LlmRequestError(res.status); // 3xx (not followed) and other 4xx
      }
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
  }
  return Buffer.concat(chunks).toString("utf8");
}
