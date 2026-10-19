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
});
