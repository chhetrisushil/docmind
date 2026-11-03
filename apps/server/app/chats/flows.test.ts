import { describe, expect, it } from "vitest";
import { chatFlow } from "./agent";
import { CHAT_EFFECT_IDS, CHAT_FLOW_ID, CHAT_GK_FLOW_ID, CHAT_SUMMARIZER_TOOL_ID } from "./ids";

describe("the chat flows' versions", () => {
  const base = {
    key: "k".repeat(32),
    contextTokens: 150_000,
    maxTokens: 16_000,
    generalKnowledge: false,
    hub: {} as never,
    bargeIn: {} as never,
  };

  it("1.0.0 is today's flow: no summarizer", () => {
    const f = chatFlow(base);
    expect(f.definition.version).toBe("1.0.0");
    expect(f.config.budget?.summarizerToolId).toBeUndefined();
  });

  it("1.1.0 summarizes evicted turns into a 1,024-token summary", () => {
    const f = chatFlow({ ...base, summarizerToolId: CHAT_SUMMARIZER_TOOL_ID });
    expect(f.definition.version).toBe("1.1.0");
    expect(f.config.budget).toMatchObject({
      summarizerToolId: "chat-summarize",
      maxSummaryTokens: 1024,
      contextWindow: 150_000,
    });
    expect(
      chatFlow({ ...base, generalKnowledge: true, summarizerToolId: "chat-summarize" }).definition
        .id,
    ).toBe(CHAT_GK_FLOW_ID);
    expect(f.definition.id).toBe(CHAT_FLOW_ID);
  });

  it("strict mode admits the summarizer effect for both chat flows", () => {
    expect(CHAT_EFFECT_IDS).toContain("chat-summarize");
  });
});
