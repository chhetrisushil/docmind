import { runLlmProviderConformance } from "@loom/conformance";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AnthropicMessagesProvider } from "./provider";
import { type FakeAnthropic, startFakeAnthropic } from "./testing/fakeAnthropic";

let fake: FakeAnthropic;
beforeAll(async () => {
  fake = await startFakeAnthropic();
});
afterAll(async () => {
  await fake?.close();
});

// `toolRequest: null`: this provider is text, image and pdf only in M3b (tools are refused).
runLlmProviderConformance(
  () =>
    new AnthropicMessagesProvider({
      apiKey: "test-key-not-real",
      model: "claude-haiku-5-5",
      maxTokens: 256,
      timeoutMs: 5_000,
      baseUrl: fake.url,
    }),
  "AnthropicMessagesProvider",
  { toolRequest: null },
);

// Opt in with DOCMIND_TEST_ANTHROPIC_KEY. Never set in CI; the key is never printed.
describe.skipIf(!process.env.DOCMIND_TEST_ANTHROPIC_KEY)("real Anthropic API", () => {
  it("answers a one-word prompt", async () => {
    const real = new AnthropicMessagesProvider({
      apiKey: process.env.DOCMIND_TEST_ANTHROPIC_KEY as string,
      model: "claude-haiku-5-5",
      maxTokens: 32,
      timeoutMs: 30_000,
    });
    const res = await real.complete({
      messages: [{ role: "user", content: "Reply with the word ok" }],
    });
    expect(res.content.length).toBeGreaterThan(0);
  });
});
