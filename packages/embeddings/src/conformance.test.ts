import { runEmbeddingProviderConformance } from "@loom/conformance";
import { afterAll, beforeAll, describe } from "vitest";
import { OllamaEmbeddingProvider } from "./ollama";
import { type FakeOllama, startFakeOllama } from "./testing/fakeOllama";

let fake: FakeOllama;
beforeAll(async () => {
  fake = await startFakeOllama({ dimensions: 64 });
});
afterAll(async () => {
  await fake?.close();
});

runEmbeddingProviderConformance(
  () => new OllamaEmbeddingProvider({ baseUrl: fake.url, model: "fake-embed", dimensions: 64 }),
  "OllamaEmbeddingProvider over the fake server",
);

// The same kit against a real Ollama: opt in with DOCMIND_TEST_OLLAMA_URL (after `ollama pull nomic-embed-text`).
describe.skipIf(!process.env.DOCMIND_TEST_OLLAMA_URL)("real Ollama", () => {
  runEmbeddingProviderConformance(
    () =>
      new OllamaEmbeddingProvider({
        baseUrl: process.env.DOCMIND_TEST_OLLAMA_URL as string,
        model: process.env.DOCMIND_TEST_OLLAMA_MODEL ?? "nomic-embed-text",
        dimensions: Number(process.env.DOCMIND_TEST_OLLAMA_DIMENSIONS ?? 768),
      }),
    "OllamaEmbeddingProvider over real Ollama",
  );
});
