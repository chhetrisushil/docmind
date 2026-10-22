import { describe, expect, it } from "vitest";
import { llmWarnings, loadLlmRoles } from "../llm/roles";
import { StartupConfigError } from "../startupError";
import { loadChatSettings } from "./settings";

const KEY = "k".repeat(32);
const OFF = { DOCMIND_LLM_PROVIDER: "off" };
const withKey = {
  DOCMIND_LLM_PROVIDER: "anthropic",
  ANTHROPIC_API_KEY: "sk-test-not-real",
  DOCMIND_CHAT_ENVELOPE_KEY: KEY,
};

describe("loadChatSettings", () => {
  it("has the decided defaults", () => {
    expect(loadChatSettings(withKey)).toEqual({
      model: "claude-opus-5-5",
      effort: "medium",
      maxTokens: 16_000,
      contextTokens: 150_000,
      hops: 1,
      generalKnowledge: false,
      titleModel: "claude-haiku-5-5",
      provider: "anthropic",
      titleProvider: "anthropic",
      envelopeKey: KEY,
      previousKeys: [],
    });
  });

  it("reads every variable", () => {
    const s = loadChatSettings({
      ...withKey,
      DOCMIND_CHAT_MODEL: "claude-sonnet-5-5",
      DOCMIND_CHAT_EFFORT: "high",
      DOCMIND_CHAT_MAX_TOKENS: "8000",
      DOCMIND_CHAT_CONTEXT_TOKENS: "100000",
      DOCMIND_RETRIEVAL_HOPS: "2",
      DOCMIND_CHAT_GENERAL_KNOWLEDGE: "true",
      DOCMIND_TITLE_MODEL: "claude-haiku-5-5",
      DOCMIND_CHAT_ENVELOPE_KEY_PREVIOUS: `${"p".repeat(32)}, ${"q".repeat(40)}`,
    });
    expect(s).toMatchObject({
      model: "claude-sonnet-5-5",
      effort: "high",
      maxTokens: 8_000,
      contextTokens: 100_000,
      hops: 2,
      generalKnowledge: true,
    });
    expect(s.previousKeys).toEqual(["p".repeat(32), "q".repeat(40)]);
  });

  it.each([
    ["DOCMIND_CHAT_MODEL", "Claude Opus"],
    ["DOCMIND_TITLE_MODEL", "-x"],
    ["DOCMIND_CHAT_EFFORT", "extreme"],
    ["DOCMIND_CHAT_MAX_TOKENS", "0"],
    ["DOCMIND_CHAT_MAX_TOKENS", "64001"],
    ["DOCMIND_CHAT_MAX_TOKENS", "many"],
    ["DOCMIND_CHAT_CONTEXT_TOKENS", "1000001"],
    ["DOCMIND_RETRIEVAL_HOPS", "3"],
    ["DOCMIND_RETRIEVAL_HOPS", "-1"],
    ["DOCMIND_RETRIEVAL_HOPS", "1.5"],
    ["DOCMIND_CHAT_GENERAL_KNOWLEDGE", "yes"],
    ["DOCMIND_CHAT_ENVELOPE_KEY", "short-secret-value"],
    ["DOCMIND_CHAT_ENVELOPE_KEY_PREVIOUS", "short-secret-value"],
  ])("refuses %s=%s with an error that names the variable and not the value", (name, value) => {
    const run = () => loadChatSettings({ ...withKey, [name]: value });
    expect(run).toThrow(StartupConfigError);
    expect(run).toThrow(new RegExp(name));
    // Short values ("0", "3") can occur in a fixed message by chance; the secrets are long.
    if (value.length >= 12) {
      try {
        run();
      } catch (err) {
        expect((err as Error).message).not.toContain(value);
      }
    }
  });

  it("refuses a context window under twice the reply size", () => {
    expect(() =>
      loadChatSettings({
        ...withKey,
        DOCMIND_CHAT_MAX_TOKENS: "16000",
        DOCMIND_CHAT_CONTEXT_TOKENS: "20000",
      }),
    ).toThrow(/DOCMIND_CHAT_CONTEXT_TOKENS.*DOCMIND_CHAT_MAX_TOKENS/);
  });

  it("defaults to Ollama gemma for chat and titles, with a per-process key when none is set (G03)", () => {
    const s = loadChatSettings({});
    expect(s).toMatchObject({
      provider: "ollama",
      titleProvider: "ollama",
      model: "gemma4:31b-cloud",
      titleModel: "gemma4:31b-cloud",
    });
    expect(s.envelopeKey.length).toBeGreaterThanOrEqual(32);
    expect(loadChatSettings({}).envelopeKey).not.toBe(s.envelopeKey);
  });

  it("an enabled chat without DOCMIND_CHAT_ENVELOPE_KEY keeps a per-process key; the warning names only the variable", () => {
    const env = { DOCMIND_LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-test-not-real" };
    expect(() => loadChatSettings(env)).not.toThrow();
    const w = llmWarnings(loadLlmRoles(env), env);
    expect(w).toContain(
      "DOCMIND_CHAT_ENVELOPE_KEY is not set: chat envelopes do not survive a restart",
    );
    const keyed = { ...env, DOCMIND_CHAT_ENVELOPE_KEY: KEY };
    expect(llmWarnings(loadLlmRoles(keyed), keyed).join("\n")).not.toContain("ENVELOPE");
    const off = { DOCMIND_CHAT_PROVIDER: "off" };
    expect(llmWarnings(loadLlmRoles(off), off).join("\n")).not.toContain("ENVELOPE");
  });

  it("chat off still gets a per-process key, and the chat and title providers are read", () => {
    const s = loadChatSettings({
      DOCMIND_CHAT_PROVIDER: "off",
      DOCMIND_TITLE_PROVIDER: "gemini",
      GEMINI_API_KEY: "g",
    });
    expect(s.provider).toBe("off");
    expect(s.titleProvider).toBe("gemini");
    expect(s.envelopeKey.length).toBeGreaterThanOrEqual(32);
  });

  it("accepts DOCMIND_CHAT_EFFORT=max", () => {
    expect(loadChatSettings({ DOCMIND_CHAT_EFFORT: "max" }).effort).toBe("max");
  });

  it("without an API key uses a random per-process key, different each time and long enough", () => {
    const a = loadChatSettings(OFF).envelopeKey;
    const b = loadChatSettings(OFF).envelopeKey;
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(32);
  });

  it("refuses previous keys without a current one, and more than four", () => {
    expect(() => loadChatSettings({ ...OFF, DOCMIND_CHAT_ENVELOPE_KEY_PREVIOUS: KEY })).toThrow(
      /DOCMIND_CHAT_ENVELOPE_KEY_PREVIOUS needs DOCMIND_CHAT_ENVELOPE_KEY/,
    );
    const five = Array.from({ length: 5 }, (_, i) => String(i).repeat(32)).join(",");
    expect(() =>
      loadChatSettings({ ...withKey, DOCMIND_CHAT_ENVELOPE_KEY_PREVIOUS: five }),
    ).toThrow(/DOCMIND_CHAT_ENVELOPE_KEY_PREVIOUS holds at most 4 keys/);
  });

  it("treats blank values as unset", () => {
    expect(
      loadChatSettings({
        ...withKey,
        DOCMIND_CHAT_MODEL: " ",
        DOCMIND_RETRIEVAL_HOPS: "",
        DOCMIND_CHAT_ENVELOPE_KEY_PREVIOUS: " ",
      }),
    ).toMatchObject({ model: "claude-opus-5-5", hops: 1, previousKeys: [] });
  });
});
