import { describe, expect, it } from "vitest";
import { StartupConfigError } from "../startupError";
import { loadChatSettings } from "./settings";

const KEY = "k".repeat(32);
const withKey = { ANTHROPIC_API_KEY: "sk-test-not-real", DOCMIND_CHAT_ENVELOPE_KEY: KEY };

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

  it("requires the envelope key when an API key is set, and says which variable", () => {
    expect(() => loadChatSettings({ ANTHROPIC_API_KEY: "sk-test-not-real" })).toThrow(
      /^DOCMIND_CHAT_ENVELOPE_KEY is required when ANTHROPIC_API_KEY is set$/,
    );
  });

  it("without an API key uses a random per-process key, different each time and long enough", () => {
    const a = loadChatSettings({}).envelopeKey;
    const b = loadChatSettings({}).envelopeKey;
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(32);
  });

  it("refuses previous keys without a current one, and more than four", () => {
    expect(() => loadChatSettings({ DOCMIND_CHAT_ENVELOPE_KEY_PREVIOUS: KEY })).toThrow(
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
