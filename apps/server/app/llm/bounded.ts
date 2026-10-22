import {
  LlmAbortedError,
  LlmOutputError,
  LlmRefusalError,
  LlmRequestError,
  LlmStreamError,
  LlmUnavailableError,
} from "@docmind/llm-anthropic";
import type { LlmProvider, LlmRequest, LlmStreamChunk } from "@loom/llm";

export interface BoundedOptions {
  maxTokens: number;
  timeoutMs: number;
}

/** 401 / 403, or any status Loom marks `kind: "auth"` (Gemini's invalid-key 400): the key or the account is wrong. Permanent, and the message names nothing. */
export class LlmConfigError extends LlmRequestError {
  constructor(status: number) {
    super(status);
    this.name = "LlmConfigError";
    this.message = `the language model credentials were rejected (HTTP ${status})`;
  }
}

const TRANSIENT_STATUS = new Set([408, 409, 429]);
const NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

/** undici's network failures: `fetch failed` (cause carries the code) and `terminated` (a body cut short). */
function isNetworkTypeError(err: TypeError): boolean {
  const code = (err.cause as { code?: unknown } | null | undefined)?.code;
  if (typeof code === "string" && NETWORK_CODES.has(code)) return true;
  return err.message.startsWith("fetch failed") || err.message === "terminated";
}

const statusOf = (err: unknown): number | undefined => {
  const s = (err as { status?: unknown }).status;
  return typeof s === "number" && Number.isInteger(s) ? s : undefined;
};

const MAX_CAUSE_DEPTH = 5;

/** What one level of the chain is, if it is a known provider failure (matched by name, not instanceof). */
function classifyOne(err: unknown): Error | undefined {
  if (!(err instanceof Error)) return undefined;
  switch (err.name) {
    case "LlmHttpError": {
      const status = statusOf(err);
      if (status === undefined) return new LlmRequestError();
      // Loom marks a rejected credential `kind: "auth"` on any status (Gemini answers a bad key with 400).
      if (status === 401 || status === 403 || (err as { kind?: unknown }).kind === "auth")
        return new LlmConfigError(status);
      return status >= 500 || TRANSIENT_STATUS.has(status)
        ? new LlmUnavailableError(status)
        : new LlmRequestError(status);
    }
    case "LlmStreamError":
      return new LlmStreamError();
    case "UnsupportedModalityError":
      return new LlmRequestError();
    default:
      return undefined;
  }
}

const TYPED = new Set([
  "LlmUnavailableError",
  "LlmRequestError",
  "LlmConfigError",
  "LlmRefusalError",
  "LlmAbortedError",
  "LlmOutputError",
]);

/** The Anthropic provider reports 401 / 403 as a plain LlmRequestError; the others get the config error. */
const asConfig = (err: Error): Error =>
  err instanceof LlmRequestError && !(err instanceof LlmConfigError)
    ? (() => {
        const s = statusOf(err);
        return s === 401 || s === 403 ? new LlmConfigError(s) : err;
      })()
    : err;

/** One of DocMind's typed errors, recognised by instanceof and by name (a second copy of the package). */
const isTyped = (err: unknown): err is Error =>
  err instanceof LlmUnavailableError ||
  err instanceof LlmRequestError ||
  err instanceof LlmRefusalError ||
  err instanceof LlmAbortedError ||
  err instanceof LlmOutputError ||
  (err instanceof Error && TYPED.has(err.name));

/** The generic shapes: a timeout, an abort nobody asked for, a network failure. */
function classifyGeneric(err: unknown): Error | undefined {
  if (!(err instanceof Error)) return undefined;
  if (err.name === "TimeoutError" || err.name === "AbortError") return new LlmUnavailableError();
  return err instanceof TypeError && isNetworkTypeError(err)
    ? new LlmUnavailableError()
    : undefined;
}

/** Each level of the bounded cause chain, outermost first. */
function chain(err: unknown): unknown[] {
  const out: unknown[] = [];
  let e: unknown = err;
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH; depth++) {
    out.push(e);
    if (typeof e !== "object" || e === null) break;
    e = (e as { cause?: unknown }).cause;
    if (e === undefined) break;
  }
  return out;
}

/**
 * A Loom provider's failure as DocMind's typed, content-free error (D7). Only the HTTP status survives: the
 * provider's message can hold a prompt, a document or the key, and the mapped error has no `cause`. Loom's errors
 * are matched by name, not instanceof, so a second copy of @loom/llm is handled; the `cause` chain is walked to
 * depth 5, like Loom's own classifier. An error that is already one of ours is returned as is.
 */
export function mapLlmError(err: unknown, caller?: AbortSignal): Error {
  if (isTyped(err)) return asConfig(err);
  if (caller?.aborted) return new LlmAbortedError();
  const levels = chain(err);
  // Priority over the whole chain: a provider error or one of ours first, the generic shapes only when none exists.
  for (const e of levels) {
    const mapped = classifyOne(e);
    if (mapped) return mapped;
    if (isTyped(e)) return asConfig(e);
  }
  for (const e of levels) {
    const mapped = classifyGeneric(e);
    if (mapped) return mapped;
  }
  return new LlmRequestError(); // a body that is not JSON, a programming error, anything unforeseen
}

const bound = (signal: AbortSignal | undefined, ms: number) => {
  const timer = AbortSignal.timeout(ms);
  return { timer, signal: signal ? AbortSignal.any([signal, timer]) : timer };
};

/** A provider that reads our combined signal reports our own timeout as an abort: that is a timeout, not the caller's. */
const timedOut = (m: Error, caller: AbortSignal | undefined, timer: AbortSignal): boolean =>
  m instanceof LlmAbortedError && caller?.aborted !== true && timer.aborted;

/** The whole call (a stream included) is bounded by `timeoutMs`; a request's `maxTokens` is capped at the role's (and defaults to it). */
export function bounded(inner: LlmProvider, o: BoundedOptions): LlmProvider & { model?: string } {
  const prepare = (r: LlmRequest) => {
    const b = bound(r.signal, o.timeoutMs);
    return {
      timer: b.timer,
      request: {
        ...r,
        maxTokens: Math.min(r.maxTokens ?? o.maxTokens, o.maxTokens),
        signal: b.signal,
      } as LlmRequest,
    };
  };
  const innerStream = inner.stream?.bind(inner);
  const model = (inner as { model?: unknown }).model;
  return {
    // The summary step records provider.model; every kind keeps it.
    ...(typeof model === "string" && { model }),
    ...(inner.capabilities !== undefined && { capabilities: inner.capabilities }),
    async complete(r) {
      const { timer, request } = prepare(r);
      try {
        return await inner.complete(request);
      } catch (e) {
        const m = mapLlmError(e, r.signal);
        throw timedOut(m, r.signal, timer) ? new LlmUnavailableError() : m;
      }
    },
    ...(innerStream && {
      async *stream(r: LlmRequest): AsyncIterable<LlmStreamChunk> {
        const { timer, request } = prepare(r);
        try {
          yield* innerStream(request);
        } catch (e) {
          const mapped = mapLlmError(e, r.signal);
          const m = timedOut(mapped, r.signal, timer) ? new LlmUnavailableError() : mapped;
          // A statusless transient failure of a stream (before or after the first chunk, a timeout included) is a broken stream.
          throw m instanceof LlmUnavailableError &&
            m.status === undefined &&
            !(m instanceof LlmStreamError)
            ? new LlmStreamError()
            : m;
        }
      },
    }),
    ...(inner.warm && {
      warm: async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            inner.warm?.(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new DOMException("warm timed out", "TimeoutError")),
                o.timeoutMs,
              );
            }),
          ]);
        } catch (e) {
          throw mapLlmError(e);
        } finally {
          clearTimeout(timer);
        }
      },
    }),
  };
}
