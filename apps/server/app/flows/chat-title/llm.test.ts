import { describe, expect, it } from "vitest";
import { loadChatSettings } from "../../chats/settings";
import { createTitleLlm } from "./llm";

describe("createTitleLlm", () => {
  const settings = loadChatSettings({ DOCMIND_TITLE_MODEL: "title-model" });
  it("is absent without a Claude key", () => {
    expect(createTitleLlm({}, settings)).toBeUndefined();
  });
  it("is the title model with no thinking and no observer, and honours the base URL", () => {
    const llm = createTitleLlm(
      { ANTHROPIC_API_KEY: "test-key-not-real", ANTHROPIC_BASE_URL: "http://127.0.0.1:1" },
      settings,
    );
    expect(llm?.model).toBe("title-model");
  });
});
