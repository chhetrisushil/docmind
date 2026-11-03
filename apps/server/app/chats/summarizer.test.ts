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

  it("turns a failure into no summary and logs the class name only", async () => {
    const log = vi.fn();
    const wrapped = tolerantSummarizer(
      effect(async () => {
        throw new ModelDownError("secret question text");
      }),
      { log },
    );
    expect(await wrapped.execute(input, ctx())).toEqual({});
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith("chat summary failed: ModelDownError");
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

  it("rethrows during shutdown", async () => {
    const shutdown = new AbortController();
    shutdown.abort();
    const err = new ModelDownError("cut");
    const wrapped = tolerantSummarizer(
      effect(() => Promise.reject(err)),
      {
        shutdown: shutdown.signal,
        log: vi.fn(),
      },
    );
    await expect(wrapped.execute(input, ctx())).rejects.toBe(err);
  });
});
