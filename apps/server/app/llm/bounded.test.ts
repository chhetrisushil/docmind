import {
  LlmAbortedError,
  LlmOutputError,
  LlmRequestError,
  LlmStreamError,
  LlmStreamError as LlmStreamErrorTyped,
  LlmUnavailableError,
} from "@docmind/llm-anthropic";
import {
  LlmHttpError,
  type LlmProvider,
  type LlmRequest,
  type LlmResponse,
  type LlmStreamChunk,
  UnsupportedModalityError,
} from "@loom/llm";
import { describe, expect, it } from "vitest";
import { LlmConfigError, bounded, mapLlmError } from "./bounded";

const ASK: LlmRequest = { messages: [{ role: "user", content: "sentinel-question" }] };
const OK: LlmResponse = { content: "ok", stopReason: "end_turn" };
const o = { maxTokens: 321, timeoutMs: 60_000 };
const failWith = (e: unknown): LlmProvider => ({
  complete: async () => {
    throw e;
  },
});

describe("mapLlmError", () => {
  it.each([408, 409, 429, 500, 503, 529])("%i is transient and keeps only the status", (status) => {
    const e = mapLlmError(new LlmHttpError("openai", status));
    expect(e).toBeInstanceOf(LlmUnavailableError);
    expect(e).toMatchObject({
      status,
      message: `the language model is unavailable (HTTP ${status})`,
    });
  });
  it.each([400, 404, 413])("%i is permanent and keeps only the status", (status) => {
    const e = mapLlmError(new LlmHttpError("gemini", status));
    expect(e).toBeInstanceOf(LlmRequestError);
    expect(e).toMatchObject({ status });
    expect((e as Error).message).not.toContain("sentinel");
  });
  it.each([401, 403])(
    "%i is a non-retryable configuration error with a fixed message",
    (status) => {
      const e = mapLlmError(new LlmHttpError("gemini", status));
      expect(e).toBeInstanceOf(LlmConfigError);
      expect(e).toBeInstanceOf(LlmRequestError);
      expect(e).not.toBeInstanceOf(LlmUnavailableError);
      expect(e).toMatchObject({
        status,
        message: `the language model credentials were rejected (HTTP ${status})`,
      });
    },
  );
  it("matches Loom errors by name, so a second copy of @loom/llm is handled", () => {
    class LlmHttpError extends Error {
      status = 503;
      name = "LlmHttpError";
    }
    class LlmStreamError extends Error {
      code = "overloaded";
      name = "LlmStreamError";
    }
    expect(mapLlmError(new LlmHttpError("sentinel"))).toMatchObject({
      name: "LlmUnavailableError",
      status: 503,
    });
    const s = mapLlmError(new LlmStreamError("sentinel"));
    expect(s).toBeInstanceOf(LlmStreamErrorTyped);
    expect(s.message).not.toContain("sentinel");
  });
  it("a network-shaped TypeError is transient; a programming TypeError is not", () => {
    const net = (code: string) => Object.assign(new TypeError("fetch failed"), { cause: { code } });
    for (const code of ["ECONNREFUSED", "ETIMEDOUT", "ECONNRESET"])
      expect(mapLlmError(net(code))).toBeInstanceOf(LlmUnavailableError);
    expect(mapLlmError(new TypeError("terminated"))).toBeInstanceOf(LlmUnavailableError);
    const bug = mapLlmError(new TypeError("Cannot read properties of undefined (reading 'x')"));
    expect(bug).toBeInstanceOf(LlmRequestError);
    expect(bug).not.toBeInstanceOf(LlmUnavailableError);
    expect(bug.message).not.toContain("undefined");
  });
  it("a caller abort is LlmAbortedError, whatever threw", () => {
    const ac = new AbortController();
    ac.abort();
    expect(mapLlmError(new DOMException("x", "AbortError"), ac.signal)).toBeInstanceOf(
      LlmAbortedError,
    );
  });
  it("a timeout and a network failure are transient; an unsupported modality and a bad body are permanent", () => {
    expect(mapLlmError(new DOMException("sentinel", "TimeoutError"))).toBeInstanceOf(
      LlmUnavailableError,
    );
    expect(mapLlmError(new TypeError("fetch failed: sentinel"))).toBeInstanceOf(
      LlmUnavailableError,
    );
    expect(
      mapLlmError(new UnsupportedModalityError("file", "application/pdf", "sentinel")),
    ).toBeInstanceOf(LlmRequestError);
    expect(mapLlmError(new SyntaxError("sentinel"))).toBeInstanceOf(LlmRequestError);
  });
  it("leaves an already typed error alone", () => {
    const e = new LlmOutputError();
    expect(mapLlmError(e)).toBe(e);
  });
});

describe("bounded", () => {
  it("fills maxTokens, keeps an explicit one, and sets a signal", async () => {
    const seen: LlmRequest[] = [];
    const inner: LlmProvider = {
      complete: async (r) => {
        seen.push(r);
        return OK;
      },
    };
    const p = bounded(inner, o);
    await p.complete(ASK);
    await p.complete({ ...ASK, maxTokens: 5 });
    expect(seen.map((r) => r.maxTokens)).toEqual([321, 5]);
    expect(seen.every((r) => r.signal instanceof AbortSignal)).toBe(true);
  });
  it("maps a failing complete without the message", async () => {
    await expect(
      bounded(failWith(new LlmHttpError("openai", 429)), o).complete(ASK),
    ).rejects.toBeInstanceOf(LlmUnavailableError);
    await expect(bounded(failWith(new Error("sentinel-prompt")), o).complete(ASK)).rejects.toThrow(
      /^the language model rejected the request$/,
    );
  });
  it("times out through the signal", async () => {
    const hang: LlmProvider = {
      complete: (r) =>
        new Promise((_, reject) =>
          r.signal?.addEventListener("abort", () => reject(r.signal?.reason)),
        ),
    };
    await expect(
      bounded(hang, { maxTokens: 1, timeoutMs: 1 }).complete(ASK),
    ).rejects.toBeInstanceOf(LlmUnavailableError);
  });
  it("reports a caller abort as LlmAbortedError", async () => {
    const ac = new AbortController();
    const hang: LlmProvider = {
      complete: (r) =>
        new Promise((_, reject) =>
          r.signal?.addEventListener("abort", () => reject(r.signal?.reason)),
        ),
    };
    const pending = bounded(hang, o).complete({ ...ASK, signal: ac.signal });
    ac.abort();
    await expect(pending).rejects.toBeInstanceOf(LlmAbortedError);
  });
  it("forwards capabilities and warm, and has stream only when the inner has it", async () => {
    let warmed = false;
    const inner: LlmProvider = {
      capabilities: { image: ["image/png"], reasoning: true },
      complete: async () => OK,
      warm: () => {
        warmed = true;
      },
    };
    const p = bounded(inner, o);
    expect(p.capabilities).toEqual({ image: ["image/png"], reasoning: true });
    expect(p.stream).toBeUndefined();
    await p.warm?.();
    expect(warmed).toBe(true);
  });
  it("streams the inner chunks, fills maxTokens, and maps a broken stream to LlmStreamError", async () => {
    const seen: LlmRequest[] = [];
    const chunks: LlmStreamChunk[] = [
      { delta: "a", done: false },
      { delta: "", done: true, stopReason: "end_turn" },
    ];
    const good: LlmProvider = {
      complete: async () => OK,
      async *stream(r) {
        seen.push(r);
        yield* chunks;
      },
    };
    const out: LlmStreamChunk[] = [];
    const stream = bounded(good, o).stream;
    if (!stream) throw new Error("stream missing");
    for await (const c of stream(ASK)) out.push(c);
    expect(out).toEqual(chunks);
    expect(seen[0]?.maxTokens).toBe(321);

    const broken: LlmProvider = {
      complete: async () => OK,
      async *stream() {
        yield { delta: "a", done: false };
        throw new TypeError("terminated");
      },
    };
    const brokenStream = bounded(broken, o).stream;
    if (!brokenStream) throw new Error("stream missing");
    const it = brokenStream(ASK)[Symbol.asyncIterator]();
    await it.next();
    await expect(it.next()).rejects.toBeInstanceOf(LlmStreamError);
  });
});

describe("fix round 1", () => {
  const httpLike = (status: unknown) =>
    Object.assign(new Error("sentinel"), { name: "LlmHttpError", status });
  const hangStream = (): LlmProvider => ({
    complete: async () => OK,
    stream: (r) => ({
      [Symbol.asyncIterator]: () => ({
        next: () =>
          new Promise<IteratorResult<LlmStreamChunk>>((_, reject) =>
            r.signal?.addEventListener("abort", () => reject(r.signal?.reason)),
          ),
      }),
    }),
  });
  const drain = async (p: LlmProvider, req: LlmRequest) => {
    if (!p.stream) throw new Error("stream missing");
    for await (const _ of p.stream(req)) {
      /* drain */
    }
  };

  it("walks a bounded cause chain", () => {
    const wrapped = new Error("outer", { cause: new Error("mid", { cause: httpLike(503) }) });
    expect(mapLlmError(wrapped)).toMatchObject({ name: "LlmUnavailableError", status: 503 });
    const net = new Error("outer", {
      cause: Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }),
    });
    expect(mapLlmError(net)).toBeInstanceOf(LlmUnavailableError);
    let deep: Error = httpLike(503);
    for (let i = 0; i < 7; i++) deep = new Error("w", { cause: deep });
    expect(mapLlmError(deep)).toBeInstanceOf(LlmRequestError);
    expect(mapLlmError(new Error("plain"))).toBeInstanceOf(LlmRequestError);
  });
  it("marks permanent errors non-retryable", () => {
    for (const e of [
      mapLlmError(httpLike(401)),
      mapLlmError(httpLike(400)),
      mapLlmError(new Error("x")),
    ])
      expect((e as { retryable?: boolean }).retryable).toBe(false);
    expect((mapLlmError(httpLike(503)) as { retryable?: boolean }).retryable).not.toBe(false);
  });
  it("mapped errors carry no cause; a non-integer status is a request error", () => {
    expect(mapLlmError(new Error("o", { cause: httpLike(503) })).cause).toBeUndefined();
    expect(mapLlmError(httpLike(503)).cause).toBeUndefined();
    expect(mapLlmError(httpLike("503"))).toBeInstanceOf(LlmRequestError);
    expect(mapLlmError(httpLike(503.5))).toBeInstanceOf(LlmRequestError);
  });
  it("caps maxTokens at the role limit", async () => {
    const seen: LlmRequest[] = [];
    const p = bounded(
      {
        complete: async (r) => {
          seen.push(r);
          return OK;
        },
      },
      o,
    );
    await p.complete({ ...ASK, maxTokens: 99_999 });
    expect(seen[0]?.maxTokens).toBe(321);
  });
  it("a stream times out as LlmStreamError and a caller abort is LlmAbortedError", async () => {
    await expect(
      drain(bounded(hangStream(), { maxTokens: 1, timeoutMs: 1 }), ASK),
    ).rejects.toBeInstanceOf(LlmStreamError);
    const ac = new AbortController();
    const pending = drain(bounded(hangStream(), o), { ...ASK, signal: ac.signal });
    ac.abort();
    await expect(pending).rejects.toBeInstanceOf(LlmAbortedError);
  });
  it("an early break releases the inner stream", async () => {
    let released = false;
    const inner: LlmProvider = {
      complete: async () => OK,
      async *stream() {
        try {
          yield { delta: "a", done: false };
          yield { delta: "b", done: false };
        } finally {
          released = true;
        }
      },
    };
    const stream = bounded(inner, o).stream;
    if (!stream) throw new Error("stream missing");
    for await (const _ of stream(ASK)) break;
    expect(released).toBe(true);
  });
  it("warm errors are mapped and warm is bounded by the timeout", async () => {
    const bad: LlmProvider = {
      complete: async () => OK,
      warm: async () => {
        throw httpLike(503);
      },
    };
    await expect(bounded(bad, o).warm?.()).rejects.toBeInstanceOf(LlmUnavailableError);
    const hang: LlmProvider = { complete: async () => OK, warm: () => new Promise(() => {}) };
    await expect(bounded(hang, { maxTokens: 1, timeoutMs: 5 }).warm?.()).rejects.toBeInstanceOf(
      LlmUnavailableError,
    );
  });
  it("a provider error anywhere in the chain beats a generic outer shape", () => {
    const net = Object.assign(new TypeError("fetch failed"), { cause: httpLike(401) });
    expect(mapLlmError(net)).toBeInstanceOf(LlmConfigError);
    const abort = Object.assign(new Error("x"), { name: "AbortError", cause: httpLike(400) });
    const m = mapLlmError(abort);
    expect(m).toBeInstanceOf(LlmRequestError);
    expect(m).not.toBeInstanceOf(LlmUnavailableError);
    const buried = new Error("o", { cause: new LlmUnavailableError(503) });
    expect(mapLlmError(buried)).toMatchObject({ name: "LlmUnavailableError", status: 503 });
    const buriedReq = new TypeError("fetch failed", { cause: new LlmRequestError(400) });
    expect(mapLlmError(buriedReq)).toBeInstanceOf(LlmRequestError);
  });
});

describe("mapLlmError on an LlmHttpError of kind auth", () => {
  it.each([400, 404])("kind auth with status %i is a configuration error", (status) => {
    const e = mapLlmError(new LlmHttpError("gemini", status, "auth"));
    expect(e).toBeInstanceOf(LlmConfigError);
    expect(e).toMatchObject({
      status,
      message: `the language model credentials were rejected (HTTP ${status})`,
    });
  });
  it("matches by name, so a second copy of @loom/llm is handled", () => {
    const e = mapLlmError(
      Object.assign(new Error("sentinel"), { name: "LlmHttpError", status: 400, kind: "auth" }),
    );
    expect(e).toBeInstanceOf(LlmConfigError);
  });
  it("a plain 400, or an unknown kind, maps as before", () => {
    expect(mapLlmError(new LlmHttpError("gemini", 400))).not.toBeInstanceOf(LlmConfigError);
    const odd = Object.assign(new Error("x"), { name: "LlmHttpError", status: 400, kind: "other" });
    expect(mapLlmError(odd)).not.toBeInstanceOf(LlmConfigError);
  });
  it("bounded surfaces it from complete", async () => {
    await expect(
      bounded(failWith(new LlmHttpError("gemini", 400, "auth")), o).complete(ASK),
    ).rejects.toBeInstanceOf(LlmConfigError);
  });
});

describe("mapLlmError on the Anthropic provider's own errors", () => {
  it.each([401, 403])("turns an LlmRequestError(%i) into LlmConfigError", (status) => {
    const e = mapLlmError(new LlmRequestError(status));
    expect(e).toBeInstanceOf(LlmConfigError);
    expect(e).toMatchObject({ status, retryable: false });
  });
  it("leaves other LlmRequestError statuses alone", () => {
    const e = new LlmRequestError(400);
    expect(mapLlmError(e)).toBe(e);
  });
});

describe("bounded keeps what the provider reports", () => {
  it("copies model and capabilities onto the wrapper", () => {
    const inner = Object.assign(failWith(new Error("x")), {
      model: "m-1",
      capabilities: { image: ["image/png"] },
    }) as LlmProvider & { model: string };
    const w = bounded(inner, o) as LlmProvider & { model?: string };
    expect(w.model).toBe("m-1");
    expect(w.capabilities).toEqual({ image: ["image/png"] });
  });
});
