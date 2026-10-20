import { type FakeAnthropic, startFakeAnthropic } from "@docmind/llm-anthropic/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StartupConfigError } from "../startupError";
import { createChatLlm } from "./llm";
import { loadChatSettings } from "./settings";

const KEY = "k".repeat(32);
let fake: FakeAnthropic;
beforeEach(async () => {
  fake = await startFakeAnthropic();
});
afterEach(async () => {
  await fake.close();
});

const env = (over: Record<string, string> = {}) => ({
  ANTHROPIC_API_KEY: "sk-test-not-real",
  DOCMIND_CHAT_ENVELOPE_KEY: KEY,
  ...over,
});

describe("createChatLlm", () => {
  it("is absent without an API key (chat is unavailable, D12)", () => {
    expect(createChatLlm({}, loadChatSettings({}))).toBeUndefined();
  });

  it("sends the chat request shape: the chat model and effort, adaptive summarized thinking, no temperature, streaming", async () => {
    const e = env({
      ANTHROPIC_BASE_URL: fake.url,
      DOCMIND_CHAT_EFFORT: "high",
      DOCMIND_CHAT_MAX_TOKENS: "4000",
    });
    const llm = createChatLlm(e, loadChatSettings(e));
    fake.reply(() => ({ stream: { steps: [{ text: "Hi" }, { stop: "end_turn" }] } }));
    for await (const _ of llm?.provider.stream?.({
      messages: [{ role: "user", content: "hello" }],
    }) ?? [])
      void _;
    const body = fake.requests[0]?.body as unknown as Record<string, unknown>;
    expect(body).toMatchObject({
      model: "claude-opus-5-5",
      max_tokens: 4_000,
      stream: true,
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "high" },
    });
    expect(body).not.toHaveProperty("temperature");
  });

  it("asks the observer slot per request, so the stores can be attached after construction", async () => {
    const e = env({ ANTHROPIC_BASE_URL: fake.url });
    const llm = createChatLlm(e, loadChatSettings(e));
    const thinking: string[] = [];
    if (llm) {
      llm.observer.current = () => ({
        blocksFor: async () => [],
        onThinking: (t) => void thinking.push(t),
        onBlocks: async () => {},
        onRefusal: async () => {},
        onUsage: () => {},
      });
    }
    fake.reply(() => ({
      stream: {
        steps: [
          { thinking: "Considering the question." },
          { signature: "s" },
          { text: "Hi" },
          { stop: "end_turn" },
        ],
      },
    }));
    for await (const _ of llm?.provider.stream?.({
      messages: [{ role: "user", content: "hello" }],
    }) ?? [])
      void _;
    expect(thinking.join("")).toBe("Considering the question.");
  });

  it("never carries the API key on the object it returns", () => {
    const e = env({ ANTHROPIC_BASE_URL: fake.url });
    const llm = createChatLlm(e, loadChatSettings(e));
    expect(JSON.stringify(llm)).not.toContain("sk-test-not-real");
  });

  it("names the variable, not the value, for a bad base URL or key", () => {
    const badUrl = env({ ANTHROPIC_BASE_URL: "not a url" });
    expect(() => createChatLlm(badUrl, loadChatSettings(badUrl))).toThrow(StartupConfigError);
    expect(() => createChatLlm(badUrl, loadChatSettings(badUrl))).toThrow(/ANTHROPIC_BASE_URL/);
    const badKey = env({ ANTHROPIC_API_KEY: "bad\nkey" });
    expect(() => createChatLlm(badKey, loadChatSettings(badKey))).toThrow(
      /^ANTHROPIC_API_KEY must be a header-safe string$/,
    );
  });
});
