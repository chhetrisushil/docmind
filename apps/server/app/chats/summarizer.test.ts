import type { Effect, EffectContext } from "@loom/effect-runtime";
import { describe, expect, it, vi } from "vitest";
import { tolerantSummarizer } from "./summarizer";

class ModelDownError extends Error {}
const input = { messages: [{ role: "user", content: "secret question text" }] };
const effect = (execute: () => Promise<{ summary?: string }>) =>
  ({ kind: "llm", execute }) as unknown as Effect<typeof input, { summary?: string }>;
const ctx = (signal?: AbortSignal) => ({ signal }) as unknown as EffectContext;

describe("tolerantSummarizer", () => {
  it("passes a success through unchanged", async () => {
    const log = vi.fn();
    const wrapped = tolerantSummarizer(
      effect(async () => ({ summary: "s" })),
      { log },
    );
    expect(await wrapped.execute(input, ctx())).toEqual({ summary: "s" });
    expect(wrapped.kind).toBe("llm");
    expect(log).not.toHaveBeenCalled();
  });

  it("turns a non-retryable failure into no summary without a retry, and logs the class name only", async () => {
    const log = vi.fn();
    const execute = vi.fn(async () => {
      throw Object.assign(new ModelDownError("secret question text"), { retryable: false });
    });
    const wrapped = tolerantSummarizer(effect(execute), { log, sleep: vi.fn() });
    expect(await wrapped.execute(input, ctx())).toEqual({});
    expect(execute).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith("chat summary failed: ModelDownError");
  });

  it("retries a retryable failure with backoff, then passes the success through", async () => {
    const log = vi.fn();
    const sleep = vi.fn(async (_ms: number, _signal?: AbortSignal) => {});
    const execute = vi
      .fn<() => Promise<{ summary?: string }>>()
      .mockRejectedValueOnce(new ModelDownError("429"))
      .mockResolvedValueOnce({ summary: "ok" });
    const wrapped = tolerantSummarizer(effect(execute), { log, sleep, retryDelaysMs: [5, 9] });
    expect(await wrapped.execute(input, ctx())).toEqual({ summary: "ok" });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep.mock.calls[0]?.[0]).toBe(5);
    expect(log).not.toHaveBeenCalled();
  });

  it("gives up after two retries: no summary, one log line", async () => {
    const log = vi.fn();
    const sleep = vi.fn(async (_ms: number, _signal?: AbortSignal) => {});
    const execute = vi.fn(async () => {
      throw new ModelDownError("529");
    });
    const wrapped = tolerantSummarizer(effect(execute), { log, sleep, retryDelaysMs: [5, 9] });
    expect(await wrapped.execute(input, ctx())).toEqual({});
    expect(execute).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([5, 9]);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("rethrows when the call's signal aborts during the backoff", async () => {
    const abort = new AbortController();
    const err = new ModelDownError("529");
    const execute = vi.fn(async () => {
      throw err;
    });
    const wrapped = tolerantSummarizer(effect(execute), { log: vi.fn(), retryDelaysMs: [60_000] });
    const run = wrapped.execute(input, ctx(abort.signal));
    await new Promise((r) => setTimeout(r, 10));
    abort.abort();
    await expect(run).rejects.toBe(err);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("rethrows when the call's signal is aborted", async () => {
    const abort = new AbortController();
    abort.abort();
    const err = new ModelDownError("cut");
    const log = vi.fn();
    const wrapped = tolerantSummarizer(
      effect(() => Promise.reject(err)),
      { log },
    );
    await expect(wrapped.execute(input, ctx(abort.signal))).rejects.toBe(err);
    expect(log).not.toHaveBeenCalled();
  });

  const settled = (p: Promise<unknown>) =>
    Promise.race([p.then(() => "settled"), new Promise((r) => setTimeout(() => r("pending"), 30))]);

  it("never settles on a shutdown (the step is left un-completed), logging nothing", async () => {
    const shutdown = new AbortController();
    shutdown.abort();
    const log = vi.fn();
    const wrapped = tolerantSummarizer(
      effect(() => Promise.reject(new ModelDownError("cut"))),
      { shutdown: shutdown.signal, log },
    );
    expect(await settled(wrapped.execute(input, ctx()))).toBe("pending");
    expect(log).not.toHaveBeenCalled();
  });

  it("cuts the in-flight request when the shutdown fires, and never settles", async () => {
    const shutdown = new AbortController();
    let seen: AbortSignal | undefined;
    const inner = {
      kind: "llm",
      execute: (_i: unknown, c: EffectContext) =>
        new Promise((_, reject) => {
          seen = c.signal;
          c.signal?.addEventListener("abort", () => reject(new ModelDownError("cut")));
        }),
    } as unknown as Effect<typeof input, { summary?: string }>;
    const wrapped = tolerantSummarizer(inner, { shutdown: shutdown.signal, log: vi.fn() });
    const run = wrapped.execute(input, ctx());
    shutdown.abort();
    expect(seen?.aborted).toBe(true);
    expect(await settled(run)).toBe("pending");
  });

  it("never settles when the shutdown fires during the backoff", async () => {
    const shutdown = new AbortController();
    const execute = vi.fn(async () => {
      throw new ModelDownError("529");
    });
    const wrapped = tolerantSummarizer(effect(execute), {
      shutdown: shutdown.signal,
      log: vi.fn(),
      retryDelaysMs: [60_000],
    });
    const run = wrapped.execute(input, ctx());
    await new Promise((r) => setTimeout(r, 10));
    shutdown.abort();
    expect(await settled(run)).toBe("pending");
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
