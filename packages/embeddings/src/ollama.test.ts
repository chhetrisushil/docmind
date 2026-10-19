import { EmbeddingError } from "@loom/memory";
import { describe, expect, it } from "vitest";
import { EmbeddingUnavailableError, OllamaEmbeddingProvider } from "./ollama";

const vec = (n: number, seed = 1) => Array.from({ length: n }, (_, i) => seed + i);
const ok = (embeddings: unknown[]) =>
  new Response(JSON.stringify({ embeddings }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
const provider = (
  fetch: typeof globalThis.fetch,
  over: Partial<ConstructorParameters<typeof OllamaEmbeddingProvider>[0]> = {},
) =>
  new OllamaEmbeddingProvider({
    baseUrl: "http://127.0.0.1:11434",
    model: "m",
    dimensions: 3,
    fetch,
    ...over,
  });

describe("OllamaEmbeddingProvider", () => {
  it("posts the model and the batch to /api/embed and returns the vectors in order", async () => {
    const seen: { url: string; body: unknown }[] = [];
    const p = provider(async (url, init) => {
      seen.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return ok([vec(3, 1), vec(3, 2)]);
    });
    expect(await p.embed(["a", "b"])).toEqual([vec(3, 1), vec(3, 2)]);
    expect(seen).toEqual([
      {
        url: "http://127.0.0.1:11434/api/embed",
        body: { model: "m", input: ["a", "b"], truncate: true },
      },
    ]);
    expect(p).toMatchObject({ modelId: "ollama/m", dimensions: 3, maxBatchSize: 64 });
  });

  it("returns nothing for nothing, without calling the server", async () => {
    const p = provider(async () => {
      throw new Error("must not be called");
    });
    expect(await p.embed([])).toEqual([]);
  });

  it("splits a batch over maxBatchSize into sequential requests and keeps the order", async () => {
    const sizes: number[] = [];
    const p = provider(
      async (_u, init) => {
        const n = (JSON.parse(String(init?.body)).input as string[]).length;
        sizes.push(n);
        return ok(Array.from({ length: n }, () => vec(3)));
      },
      { maxBatchSize: 2 },
    );
    expect((await p.embed(["a", "b", "c", "d", "e"])).length).toBe(5);
    expect(sizes).toEqual([2, 2, 1]);
  });

  it.each([429, 500, 503])("treats HTTP %s as transient", async (status) => {
    const p = provider(async () => new Response("x", { status }));
    await expect(p.embed(["a"])).rejects.toBeInstanceOf(EmbeddingUnavailableError);
  });

  it("treats a network failure and a timeout as transient", async () => {
    const down = provider(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(down.embed(["a"])).rejects.toBeInstanceOf(EmbeddingUnavailableError);
    const slow = provider(hang, { timeoutMs: 1 });
    await expect(slow.embed(["a"])).rejects.toBeInstanceOf(EmbeddingUnavailableError);
  });

  it("treats 404 (model not pulled), 400 and a redirect status as permanent, not transient", async () => {
    for (const status of [400, 404, 302]) {
      const p = provider(async () => new Response("model not found", { status }));
      const err = await p.embed(["a"]).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(EmbeddingError);
      expect(err).not.toBeInstanceOf(EmbeddingUnavailableError);
    }
  });

  it.each([
    ["a wrong count", [vec(3)]],
    ["a wrong dimension", [vec(2), vec(2)]],
    ["a null value (JSON has no NaN; a server may send null)", [vec(3), [1, null, 3]]],
    ["a string value", [vec(3), [1, "2", 3]]],
  ])("rejects %s with a permanent EmbeddingError", async (_n, embeddings) => {
    const err = await provider(async () => ok(embeddings))
      .embed(["a", "b"])
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EmbeddingError);
    expect(err).not.toBeInstanceOf(EmbeddingUnavailableError);
  });

  it("rejects a body that is not JSON or not an object with embeddings, permanently", async () => {
    for (const body of ["not json", "[]", "{}"]) {
      const err = await provider(async () => new Response(body))
        .embed(["a"])
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(EmbeddingError);
      expect(err).not.toBeInstanceOf(EmbeddingUnavailableError);
    }
  });

  it("cancels the body of an error response instead of leaving it open (F23)", async () => {
    const { body, cancelled } = trackedBody(new Uint8Array(0));
    const p = provider(async () => new Response(body, { status: 500 }));
    await expect(p.embed(["a"])).rejects.toBeInstanceOf(EmbeddingUnavailableError);
    expect(cancelled()).toBe(true);
  });
});

/** A fetch that never answers until its signal aborts. */
const hang = ((_u: unknown, init?: RequestInit) =>
  new Promise<Response>((_res, rej) =>
    init?.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))),
  )) as typeof fetch;

/** A body that records whether it was cancelled; `endless` keeps producing `chunk`. */
function trackedBody(chunk: Uint8Array, endless = false) {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      if (endless) c.enqueue(chunk);
    },
    cancel() {
      cancelled = true;
    },
  });
  return { body, cancelled: () => cancelled };
}
