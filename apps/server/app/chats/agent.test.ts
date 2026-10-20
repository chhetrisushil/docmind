import { ConversationHub } from "@loom/conversation";
import { UNTRUSTED_CONTENT_SYSTEM_NOTE } from "@loom/llm";
import { describe, expect, it } from "vitest";
import { DOC_ASSISTANT_GK_PROMPT, DOC_ASSISTANT_PROMPT, chatFlow, docAssistant } from "./agent";
import { CHAT_FLOW_ID, CHAT_GK_FLOW_ID, CHAT_TOOL_IDS } from "./ids";

const KEY = "k".repeat(32);
const base = () => ({
  key: KEY,
  contextTokens: 150_000,
  maxTokens: 16_000,
  generalKnowledge: false,
  hub: new ConversationHub(),
  bargeIn: async () => () => {},
});

describe("the prompts", () => {
  it.each([
    ["strict", DOC_ASSISTANT_PROMPT],
    ["general knowledge", DOC_ASSISTANT_GK_PROMPT],
  ])(
    "the %s prompt states the citation rule, the not-found sentence and every tool, and ends with the untrusted-content note",
    (_n, prompt) => {
      expect(prompt).toContain("[[passageId]]");
      expect(prompt).toContain("Not found in your documents.");
      for (const tool of CHAT_TOOL_IDS) expect(prompt).toContain(tool);
      expect(prompt).toContain("search_unavailable");
      expect(prompt.endsWith(UNTRUSTED_CONTENT_SYSTEM_NOTE)).toBe(true);
      expect(prompt).not.toMatch(/undefined|\$\{/);
    },
  );

  it("forbids general knowledge in the strict prompt and labels it in the other", () => {
    expect(DOC_ASSISTANT_PROMPT).toContain("Do not answer from general knowledge");
    expect(DOC_ASSISTANT_PROMPT).not.toContain("General knowledge:");
    expect(DOC_ASSISTANT_GK_PROMPT).toContain("General knowledge:");
    expect(DOC_ASSISTANT_GK_PROMPT).not.toContain("Do not answer from general knowledge");
  });
});

describe("docAssistant", () => {
  it("offers exactly the five read-only tools", () => {
    expect(docAssistant.id).toBe("doc-assistant");
    expect(docAssistant.tools.map((t) => t.id)).toEqual([...CHAT_TOOL_IDS]);
  });
});

describe("chatFlow (D11)", () => {
  it("builds the strict flow with the decided limits", () => {
    const flow = chatFlow(base());
    expect([flow.definition.id, flow.definition.version, flow.mode]).toEqual([
      CHAT_FLOW_ID,
      "1.0.0",
      "owner",
    ]);
    expect(flow.config.agent).toMatchObject({
      modelToolId: "chat-model",
      maxIterations: 8,
      parallelTools: true,
      toolErrors: "feedback",
      turnTimeoutMs: 180_000,
      toolTimeoutMs: 30_000,
      systemPrompt: DOC_ASSISTANT_PROMPT,
    });
    expect(flow.config.agent.definition).toBe(docAssistant);
    expect(flow.config).toMatchObject({
      budget: { contextWindow: 150_000, reserveOutputTokens: 16_000 },
      rotateEveryTurns: 50,
      maxTurnChars: 8_000,
      maxInvalidRecords: 10_000,
    });
    expect(flow.config.budget?.summarizerToolId).toBeUndefined();
  });

  it("builds the general-knowledge flow under its own id and prompt", () => {
    const flow = chatFlow({ ...base(), generalKnowledge: true });
    expect(flow.definition.id).toBe(CHAT_GK_FLOW_ID);
    expect(flow.config.agent.systemPrompt).toBe(DOC_ASSISTANT_GK_PROMPT);
  });

  it("reserves a quarter of a small window for the reply instead of the whole max", () => {
    expect(chatFlow({ ...base(), contextTokens: 20_000 }).config.budget?.reserveOutputTokens).toBe(
      5_000,
    );
  });

  it("passes the hub, the barge-in source, the rotation seam and the previous keys through", () => {
    const hub = new ConversationHub();
    const bargeIn = async () => () => {};
    const flow = chatFlow({
      ...base(),
      hub,
      bargeIn,
      rotateEveryTurns: 2,
      previousKeys: ["p".repeat(32)],
    });
    expect(flow.config.hub).toBe(hub);
    expect(flow.config.bargeIn).toBe(bargeIn);
    expect(flow.config.rotateEveryTurns).toBe(2);
    expect(flow.config.previousKeys).toEqual(["p".repeat(32)]);
  });

  it("runs in owner mode: the built config has no shared key (turns stay inside the user's crypto subject)", () => {
    for (const generalKnowledge of [false, true]) {
      const flow = chatFlow({ ...base(), generalKnowledge });
      expect(flow.mode).toBe("owner");
      expect("shared" in flow.config).toBe(false);
    }
  });

  it("refuses a key under 32 characters and does not echo it", () => {
    expect(() => chatFlow({ ...base(), key: "short-secret" })).toThrow(
      /^the chat envelope key must be at least 32 characters$/,
    );
  });
});
