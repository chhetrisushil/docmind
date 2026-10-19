import { describe, expect, it } from "vitest";
import { OllamaEmbeddingProvider } from "./ollama";

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
});
