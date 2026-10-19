import { EmbeddingError } from "@loom/memory";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  EmbeddingAbortedError,
  EmbeddingUnavailableError,
  OllamaEmbeddingProvider,
} from "./ollama";
import { type FakeOllama, startFakeOllama } from "./testing/fakeOllama";

let fake: FakeOllama;
beforeAll(async () => {
  fake = await startFakeOllama({ dimensions: 64 });
});
afterAll(async () => {
  await fake?.close();
});

const good = () =>
  new OllamaEmbeddingProvider({ baseUrl: fake.url, model: "fake-embed", dimensions: 64 });

describe("OllamaEmbeddingProvider over a real socket", () => {
  it("sends at most maxBatchSize texts per request", async () => {
    const p = new OllamaEmbeddingProvider({
      baseUrl: fake.url,
      model: "fake-embed",
      dimensions: 64,
      maxBatchSize: 64,
    });
    await p.embed(Array.from({ length: 150 }, (_, i) => `text ${i}`));
    expect(fake.batches.slice(-3)).toEqual([64, 64, 22]);
  });

  it("reports an unreachable server as transient, and an HTTP 503 too", async () => {
    const dead = await startFakeOllama({ dimensions: 64 });
    const url = dead.url;
    await dead.close();
    const gone = new OllamaEmbeddingProvider({ baseUrl: url, model: "m", dimensions: 64 });
    await expect(gone.embed(["a"])).rejects.toBeInstanceOf(EmbeddingUnavailableError);
    fake.failNext(503);
    await expect(good().embed(["a"])).rejects.toBeInstanceOf(EmbeddingUnavailableError);
    expect((await good().embed(["a"])).length).toBe(1); // and the next call is fine
  });

  it("treats an unknown model as a permanent error", async () => {
    const p = new OllamaEmbeddingProvider({
      baseUrl: fake.url,
      model: "not-pulled",
      dimensions: 64,
    });
    const err = await p.embed(["a"]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EmbeddingError);
    expect(err).not.toBeInstanceOf(EmbeddingUnavailableError);
  });

  it("treats a redirect as permanent, not as something to retry or follow", async () => {
    fake.failNext(307);
    const err = await good()
      .embed(["a"])
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EmbeddingError);
    expect(err).not.toBeInstanceOf(EmbeddingUnavailableError);
    expect((err as Error).message).toBe("the embedding service redirected the request");
  });

  it("stops waiting when the caller aborts, without leaving the request open", async () => {
    const arrived = fake.hold();
    const aborted = fake.nextAbort();
    const controller = new AbortController();
    const pending = good().embed(["a"], { signal: controller.signal });
    const settled = pending.catch((e: unknown) => e);
    await arrived; // the request is on the server, parked at the gate
    controller.abort();
    expect(await settled).toBeInstanceOf(EmbeddingAbortedError);
    await aborted; // the server saw the connection close: the request was not left open (F23)
    fake.release();
  });
});
