import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadChatSettings } from "../../chats/settings";
import { type FakeOpenAiCompat, startFakeOpenAiCompat } from "../../llm/testing";
import { createTitleLlm } from "./llm";

describe("createTitleLlm", () => {
  let compat: FakeOpenAiCompat;
  beforeEach(async () => {
    compat = await startFakeOpenAiCompat();
  });
  afterEach(async () => {
    await compat.close();
  });

  it("is absent when the title provider is off", () => {
    const env = { DOCMIND_TITLE_PROVIDER: "off" };
    expect(createTitleLlm(env, loadChatSettings(env))).toBeUndefined();
  });

  it("completes on Ollama with a 256-token cap and no reasoning_effort", async () => {
    const env = { DOCMIND_OLLAMA_URL: compat.url };
    const llm = createTitleLlm(env, loadChatSettings(env));
    compat.reply(() => ({ kind: "text", text: "A title" }));
    const r = await llm?.complete({ messages: [{ role: "user", content: "name it" }] });
    expect(r).toBeDefined();
    expect(compat.requests[0]?.body).toMatchObject({ model: "gemma4:31b-cloud", max_tokens: 256 });
    expect(compat.requests[0]?.body).not.toHaveProperty("reasoning_effort");
  });

  it("is the title model on Anthropic when selected", () => {
    const env = {
      DOCMIND_TITLE_PROVIDER: "anthropic",
      ANTHROPIC_API_KEY: "test-key-not-real",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:1",
      DOCMIND_TITLE_MODEL: "title-model",
    };
    expect(createTitleLlm(env, loadChatSettings(env))).toBeDefined();
    expect(loadChatSettings(env).titleModel).toBe("title-model");
  });
});
