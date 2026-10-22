import { type FakeAnthropic, startFakeAnthropic } from "@docmind/llm-anthropic/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type FakeOpenAiCompat, startFakeOpenAiCompat } from "../llm/testing";
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

const OFF = { DOCMIND_LLM_PROVIDER: "off" };
const env = (over: Record<string, string> = {}) => ({
  DOCMIND_LLM_PROVIDER: "anthropic",
  ANTHROPIC_API_KEY: "sk-test-not-real",
  DOCMIND_CHAT_ENVELOPE_KEY: KEY,
  ...over,
});

describe("createChatLlm", () => {
  it("is absent when the chat provider is off (chat is unavailable, D12)", () => {
    const off = { DOCMIND_CHAT_PROVIDER: "off", ...OFF };
    expect(createChatLlm(off, loadChatSettings(off))).toBeUndefined();
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
    let usages = 0;
    if (llm) {
      llm.observer.current = () => ({
        onRefusal: async () => {},
        onUsage: () => void usages++,
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
    expect(usages).toBe(1);
  });

  it("never carries the API key on the object it returns", () => {
    const e = env({ ANTHROPIC_BASE_URL: fake.url });
    const llm = createChatLlm(e, loadChatSettings(e));
    expect(JSON.stringify(llm)).not.toContain("sk-test-not-real");
  });

  it("runs on Ollama by default: model, reasoning_effort and max_tokens on the wire, reasoning declared", async () => {
    const compat: FakeOpenAiCompat = await startFakeOpenAiCompat();
    try {
      const e = {
        DOCMIND_OLLAMA_URL: compat.url,
        DOCMIND_CHAT_ENVELOPE_KEY: KEY,
        DOCMIND_CHAT_EFFORT: "low",
      };
      const llm = createChatLlm(e, loadChatSettings(e));
      expect(llm?.provider.capabilities?.reasoning).toBe(true);
      compat.reply(() => ({ kind: "text", text: "Hi", reasoning: "thinking" }));
      for await (const _ of llm?.provider.stream?.({
        messages: [{ role: "user", content: "hello" }],
      }) ?? [])
        void _;
      expect(compat.requests[0]?.body).toMatchObject({
        model: "gemma4:31b-cloud",
        reasoning_effort: "low",
        max_tokens: 16_000,
        stream: true,
      });
      expect(JSON.stringify(llm)).not.toContain("authorization");
    } finally {
      await compat.close();
    }
  });

  it("refuses a Gemini chat (roles)", () => {
    const e = { DOCMIND_CHAT_PROVIDER: "gemini", GEMINI_API_KEY: "g-test-not-real" };
    expect(() => createChatLlm(e, loadChatSettings(e))).toThrow(StartupConfigError);
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
