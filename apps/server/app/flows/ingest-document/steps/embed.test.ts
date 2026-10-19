import { randomUUID } from "node:crypto";
import { EmbeddingAbortedError, EmbeddingUnavailableError } from "@docmind/embeddings";
import { InMemoryChunkVectors } from "@docmind/vector-pg";
import { EmbeddingError, type EmbeddingProvider, HashingEmbeddingProvider } from "@loom/memory";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DocumentGoneError } from "../errors";
import { type EmbedDeps, embedEffect } from "./embed";

const T = randomUUID();
const U = randomUUID();
const DOC = randomUUID();
const SCOPE = { tenantId: T, ownerId: U };
const run = (d: EmbedDeps, signal?: AbortSignal) =>
  embedEffect({ sleep: async () => {}, ...d }).execute(
    { tenantId: T, userId: U, documentId: DOC },
    { signal } as never,
  );

function harness(n: number) {
  const chunkIds = Array.from({ length: n }, () => randomUUID());
  const embedCalls: number[] = [];
  const embedTexts: string[][] = [];
  const signals: (AbortSignal | undefined)[] = [];
  const guardCalls: string[] = [];
  let calls = 0;
  let failure: { from: number; times: number; error: Error } | undefined;
  const inner = new HashingEmbeddingProvider({ dimensions: 8 });
  const embedder: EmbeddingProvider = {
    modelId: inner.modelId,
    dimensions: 8,
    embed: async (texts, opts) => {
      calls += 1;
      signals.push(opts?.signal);
      if (failure && calls >= failure.from && failure.times-- > 0) throw failure.error;
      embedCalls.push(texts.length);
      embedTexts.push([...texts]);
      return inner.embed(texts);
    },
  };
  const deps: EmbedDeps = {
    guard: { begin: async (_r, s) => void guardCalls.push(s) },
    chunks: {
      replace: async () => n,
      count: async () => n,
      read: async (_r, ids) => ids.map((id) => ({ id, text: `t-${id}` })),
    },
    vectors: new InMemoryChunkVectors({
      modelId: embedder.modelId,
      dimensions: 8,
      chunkIds: async () => chunkIds,
    }),
    embedder,
  };
  return {
    deps,
    embedCalls,
    embedTexts,
    signals,
    guardCalls,
    chunkIds,
    failFrom: (from: number, error: Error, times = 1) => {
      failure = { from, times, error };
    },
  };
}

afterEach(() => vi.restoreAllMocks());

describe("embedEffect", () => {
  it("embeds in batches of 64 and reports {count, model} only", async () => {
    const h = harness(150);
    expect(await run(h.deps)).toEqual({
      outcome: "done",
      count: 150,
      model: h.deps.embedder.modelId,
    });
    expect(h.embedCalls).toEqual([64, 64, 22]);
    expect(await h.deps.vectors.missing(SCOPE, DOC, 1000)).toEqual([]);
  });

  it("is idempotent: a second run embeds nothing and reports the same result", async () => {
    const h = harness(70);
    await run(h.deps);
    h.embedCalls.length = 0;
    expect(await run(h.deps)).toEqual({
      outcome: "done",
      count: 70,
      model: h.deps.embedder.modelId,
    });
    expect(h.embedCalls).toEqual([]);
  });

  it("hands the embedder exactly the texts of the chunks it is embedding", async () => {
    const h = harness(3);
    await run(h.deps);
    expect(h.embedTexts.flat()).toEqual(h.chunkIds.map((id) => `t-${id}`));
  });

  it("an empty document embeds nothing and reports count 0", async () => {
    const h = harness(0);
    expect(await run(h.deps)).toEqual({
      outcome: "done",
      count: 0,
      model: h.deps.embedder.modelId,
    });
    expect(h.embedCalls).toEqual([]);
  });

  it("runs the guard first, and a gone document stops with no embedding", async () => {
    const h = harness(3);
    h.deps.guard = {
      begin: async () => {
        throw new DocumentGoneError();
      },
    };
    expect(await run(h.deps)).toEqual({ outcome: "document_gone" });
    expect(h.embedCalls).toEqual([]);
  });

  it("retries an embedder outage in the same run and resumes at the unfinished batch", async () => {
    const h = harness(100);
    h.failFrom(2, new EmbeddingUnavailableError());
    expect(await run(h.deps)).toMatchObject({ outcome: "done", count: 100 });
    expect(h.embedCalls).toEqual([64, 36]); // the failed second call is retried, batch 1 is not redone
  });

  it("gives up an outage after the retry budget with the fixed message and the class logged", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const h = harness(2);
    h.failFrom(1, new EmbeddingUnavailableError(), 99);
    await expect(run(h.deps)).rejects.toThrow(/^ingest step failed: embed$/);
    expect(spy).toHaveBeenCalledWith("ingest step failed", "embed", "EmbeddingUnavailableError");
  });

  it("fails a permanent embedder error at once, logs the class, keeps finished batches", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const h = harness(100);
    h.failFrom(2, new EmbeddingError("bad request"), 99);
    await expect(run(h.deps)).rejects.toThrow(/^ingest step failed: embed$/);
    expect(spy).toHaveBeenCalledWith("ingest step failed", "embed", "EmbeddingError");
    expect(h.signals).toHaveLength(2); // one call per batch: the failing call was not retried
    expect(await h.deps.vectors.missing(SCOPE, DOC, 1000)).toHaveLength(36);
  });

  it("fails when the embedder returns the wrong number of vectors", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const h = harness(3);
    const real = h.deps.embedder.embed.bind(h.deps.embedder);
    h.deps.embedder.embed = async (t, o) => (await real(t, o)).slice(1);
    await expect(run(h.deps)).rejects.toThrow(/^ingest step failed: embed$/);
    expect(spy).toHaveBeenCalledWith("ingest step failed", "embed", "Error");
    expect(await h.deps.vectors.missing(SCOPE, DOC, 1000)).toHaveLength(3);
  });

  it("treats an embedder abort as a cancel: not retried, not logged", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const h = harness(2);
    h.failFrom(1, new EmbeddingAbortedError(), 99);
    await expect(run(h.deps)).rejects.toThrow(/^ingest step failed: embed$/);
    expect(h.signals).toHaveLength(1);
    expect(spy).not.toHaveBeenCalled();
  });

  it("passes the attempt's signal to the embedder", async () => {
    const h = harness(1);
    await run(h.deps);
    expect(h.signals[0]).toBeInstanceOf(AbortSignal);
  });

  it("writes no vectors when the attempt was aborted while embedding", async () => {
    const h = harness(3);
    const cancel = new AbortController();
    const real = h.deps.embedder.embed.bind(h.deps.embedder);
    h.deps.embedder.embed = async (t, o) => {
      const out = await real(t, o);
      cancel.abort();
      return out;
    };
    await expect(run(h.deps, cancel.signal)).rejects.toThrow(/^ingest step failed: embed$/);
    expect(await h.deps.vectors.missing(SCOPE, DOC, 1000)).toHaveLength(3);
  });

  it("an attempt that timed out commits no vectors when its embedder finally answers", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const h = harness(2);
    const real = h.deps.embedder.embed.bind(h.deps.embedder);
    let release: () => void = () => {};
    const late = new Promise<void>((r) => {
      release = r;
    });
    h.deps.embedder.embed = async (t, o) => {
      await new Promise<void>((r) =>
        o?.signal?.addEventListener("abort", () => r(), { once: true }),
      );
      release();
      return real(t, o);
    };
    await expect(run({ ...h.deps, stepTimeoutMs: 1, attemptSettleMs: 1000 })).rejects.toThrow(
      /^ingest step failed: embed$/,
    );
    await late;
    expect(await h.deps.vectors.missing(SCOPE, DOC, 1000)).toHaveLength(2);
  });

  it("stops as document_gone when the chunk texts cannot be read for ids the vector store listed", async () => {
    const h = harness(3);
    h.deps.chunks.read = async () => [];
    expect(await run(h.deps)).toEqual({ outcome: "document_gone" });
  });

  it("stops as document_gone when the vector store says the chunk rows are gone", async () => {
    const h = harness(3);
    h.deps.vectors.upsert = async (_s, _d, items) => ({
      written: 0,
      missing: items.map((i) => i.chunkId),
    });
    expect(await run(h.deps)).toEqual({ outcome: "document_gone" });
  });

  it("fails instead of spinning when the vector store keeps listing the same ids", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const h = harness(3);
    h.deps.vectors.upsert = async () => ({ written: 0, missing: [] });
    await expect(run(h.deps)).rejects.toThrow(/^ingest step failed: embed$/);
    expect(spy).toHaveBeenCalledWith("ingest step failed", "embed", "Error");
    expect(h.embedCalls).toHaveLength(3); // one batch per attempt: the bound stops the second
  });

  it.each([
    ["model", { modelId: "other-model" }],
    ["dimensions", { dimensions: 16 }],
  ])(
    "fails at once with the config error when the %s differs from the vector store's",
    async (_n, over) => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      const h = harness(2);
      h.deps.embedder = { ...h.deps.embedder, ...over };
      await expect(run(h.deps)).rejects.toThrow(/^ingest step failed: embed$/);
      expect(spy).toHaveBeenCalledTimes(1); // one attempt
      expect(spy).toHaveBeenCalledWith("ingest step failed", "embed", "IngestConfigError");
      expect(h.embedCalls).toEqual([]);
    },
  );

  /** An embedder that serves one batch per attempt, then hangs until the attempt is abandoned. */
  function onePerAttempt(h: ReturnType<typeof harness>, serve: boolean) {
    const real = h.deps.embedder.embed.bind(h.deps.embedder);
    let last: AbortSignal | undefined;
    let attempts = 0;
    h.deps.embedder.embed = async (t, o) => {
      if (o?.signal !== last) attempts++;
      const fresh = o?.signal !== last;
      last = o?.signal;
      if (serve && fresh) return real(t, o);
      await new Promise<void>((r) =>
        o?.signal?.addEventListener("abort", () => r(), { once: true }),
      );
      throw new EmbeddingAbortedError();
    };
    return () => attempts;
  }

  it("completes a slow provider that finishes one batch per attempt (<= ceil(count/64) + 3 attempts)", async () => {
    const h = harness(200); // 4 batches
    const attempts = onePerAttempt(h, true);
    expect(await run({ ...h.deps, stepTimeoutMs: 1 })).toMatchObject({
      outcome: "done",
      count: 200,
    });
    expect(attempts()).toBeLessThanOrEqual(Math.ceil(200 / 64) + 3);
  });

  it("a provider that never completes a batch exhausts the normal three attempts", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const h = harness(200);
    const attempts = onePerAttempt(h, false);
    await expect(run({ ...h.deps, stepTimeoutMs: 1 })).rejects.toThrow(
      /^ingest step failed: embed$/,
    );
    expect(attempts()).toBe(3);
  });
});
