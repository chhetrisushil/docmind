import { describe, expect, it } from "vitest";
import { StartupConfigError } from "../startupError";
import { envModelId } from "./modelId";
import { insecureUrlWarning, llmWarnings, loadLlmRoles, pdfMaxBytes } from "./roles";

const roles = (env: Record<string, string>) => loadLlmRoles(env).roles;

describe("loadLlmRoles defaults", () => {
  it("runs everything on gemma through Ollama and turns PDF reading off without a Gemini key", () => {
    expect(roles({})).toEqual({
      chat: { provider: "ollama", model: "gemma4:31b-cloud" },
      title: { provider: "ollama", model: "gemma4:31b-cloud" },
      summary: { provider: "ollama", model: "gemma4:31b-cloud" },
      vision: { provider: "ollama", model: "gemma4:31b-cloud" },
      visionPdf: { provider: "off", model: "" },
    });
  });
  it("uses Gemini for scanned PDF pages as soon as its key exists, and for nothing else", () => {
    const r = roles({ GEMINI_API_KEY: "test-key-not-real" });
    expect(r.visionPdf).toEqual({ provider: "gemini", model: "gemini-3.5-flash" });
    expect(r.chat.provider).toBe("ollama");
  });
  it("ignores an Anthropic key on its own", () => {
    expect(roles({ ANTHROPIC_API_KEY: "test-key-not-real" }).chat.provider).toBe("ollama");
  });
});

describe("loadLlmRoles configuration", () => {
  it("DOCMIND_LLM_PROVIDER=anthropic moves every role, with the Claude defaults", () => {
    expect(
      roles({ DOCMIND_LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "test-key-not-real" }),
    ).toEqual({
      chat: { provider: "anthropic", model: "claude-opus-5-5" },
      title: { provider: "anthropic", model: "claude-haiku-5-5" },
      summary: { provider: "anthropic", model: "claude-haiku-5-5" },
      vision: { provider: "anthropic", model: "claude-sonnet-5-5" },
      visionPdf: { provider: "anthropic", model: "claude-sonnet-5-5" },
    });
  });
  it("DOCMIND_LLM_PROVIDER=ollama cannot read PDFs: that role falls back like the default", () => {
    expect(roles({ DOCMIND_LLM_PROVIDER: "ollama" }).visionPdf.provider).toBe("off");
    expect(
      roles({ DOCMIND_LLM_PROVIDER: "ollama", GEMINI_API_KEY: "test-key-not-real" }).visionPdf
        .provider,
    ).toBe("gemini");
  });
  it("a per-role variable beats the shared one, and `off` switches a role off", () => {
    const r = roles({
      DOCMIND_LLM_PROVIDER: "ollama",
      DOCMIND_TITLE_PROVIDER: "off",
      DOCMIND_SUMMARY_MODEL: "gemma4:31b-cloud",
    });
    expect(r.title).toEqual({ provider: "off", model: "" });
    expect(r.summary.provider).toBe("ollama");
  });
  it("the PDF role inherits DOCMIND_VISION_MODEL when it has the same provider (the pre-existing variable)", () => {
    const r = roles({
      DOCMIND_LLM_PROVIDER: "anthropic",
      ANTHROPIC_API_KEY: "test-key-not-real",
      DOCMIND_VISION_MODEL: "claude-custom-1",
    });
    expect(r.vision.model).toBe("claude-custom-1");
    expect(r.visionPdf.model).toBe("claude-custom-1");
  });
  it("reads the URLs and the Gemini thinking budget", () => {
    const s = loadLlmRoles({
      DOCMIND_OLLAMA_URL: "http://127.0.0.1:9",
      ANTHROPIC_BASE_URL: "https://gateway.example",
      GEMINI_BASE_URL: "http://127.0.0.1:8",
      DOCMIND_GEMINI_THINKING_BUDGET: "128",
    });
    expect(s).toMatchObject({
      ollamaUrl: "http://127.0.0.1:9",
      anthropicBaseUrl: "https://gateway.example",
      geminiBaseUrl: "http://127.0.0.1:8",
      geminiThinkingBudget: 128,
    });
    expect(loadLlmRoles({}).ollamaUrl).toBe("http://127.0.0.1:11434");
    expect(loadLlmRoles({}).geminiThinkingBudget).toBe(0);
  });
});

describe("loadLlmRoles refuses to start, naming variables and never values", () => {
  const bad = (env: Record<string, string>, message: RegExp) =>
    expect(() => loadLlmRoles(env)).toThrow(message);
  it("a provider without its credential", () => {
    bad(
      { DOCMIND_CHAT_PROVIDER: "anthropic" },
      /^ANTHROPIC_API_KEY is not set \(DOCMIND_CHAT_PROVIDER=anthropic\)$/,
    );
    bad(
      { DOCMIND_VISION_PDF_PROVIDER: "gemini" },
      /^GEMINI_API_KEY is not set \(DOCMIND_VISION_PDF_PROVIDER=gemini\)$/,
    );
  });
  it("a missing credential names the variable that chose the provider", () => {
    bad(
      { DOCMIND_LLM_PROVIDER: "anthropic" },
      /^ANTHROPIC_API_KEY is not set \(DOCMIND_LLM_PROVIDER=anthropic\)$/,
    );
    bad(
      {
        DOCMIND_LLM_PROVIDER: "anthropic",
        DOCMIND_TITLE_PROVIDER: "off",
        DOCMIND_CHAT_PROVIDER: "off",
        DOCMIND_SUMMARY_PROVIDER: "off",
        DOCMIND_VISION_PROVIDER: "off",
      },
      /^ANTHROPIC_API_KEY is not set \(DOCMIND_LLM_PROVIDER=anthropic\)$/,
    );
  });
  it("a Claude model id left from a Claude-only .env, naming the variable that set it", () => {
    bad(
      { DOCMIND_SUMMARY_MODEL: "claude-haiku-5-5" },
      /^DOCMIND_SUMMARY_MODEL names a Claude model but DOCMIND_SUMMARY_PROVIDER is ollama$/,
    );
    bad(
      { DOCMIND_LLM_PROVIDER: "ollama", DOCMIND_VISION_MODEL: "claude-sonnet-5-5" },
      /^DOCMIND_VISION_MODEL names a Claude model but DOCMIND_LLM_PROVIDER is ollama$/,
    );
    bad(
      {
        DOCMIND_VISION_PDF_PROVIDER: "gemini",
        GEMINI_API_KEY: "test-key-not-real",
        DOCMIND_VISION_PDF_MODEL: "claude-sonnet-5-5",
      },
      /^DOCMIND_VISION_PDF_MODEL names a Claude model but DOCMIND_VISION_PDF_PROVIDER is gemini$/,
    );
    expect(
      roles({
        DOCMIND_LLM_PROVIDER: "anthropic",
        ANTHROPIC_API_KEY: "test-key-not-real",
        DOCMIND_SUMMARY_MODEL: "claude-haiku-5-5",
      }).summary.model,
    ).toBe("claude-haiku-5-5");
  });
  it("an impossible combination", () => {
    bad(
      { DOCMIND_CHAT_PROVIDER: "gemini", GEMINI_API_KEY: "test-key-not-real" },
      /^DOCMIND_CHAT_PROVIDER cannot be gemini: the chat needs streaming$/,
    );
    bad(
      { DOCMIND_VISION_PDF_PROVIDER: "ollama" },
      /^DOCMIND_VISION_PDF_PROVIDER cannot be ollama: it takes no PDF input$/,
    );
  });
  it("an unknown provider, a bad model id, a bad budget", () => {
    bad(
      { DOCMIND_SUMMARY_PROVIDER: "openai" },
      /^DOCMIND_SUMMARY_PROVIDER must be one of anthropic, ollama, gemini, off$/,
    );
    bad({ DOCMIND_CHAT_MODEL: "Not A Model!" }, /^DOCMIND_CHAT_MODEL must be a model id$/);
    bad(
      { DOCMIND_GEMINI_THINKING_BUDGET: "-1" },
      /^DOCMIND_GEMINI_THINKING_BUDGET must be a whole number from 0 to 24576$/,
    );
    expect(() => loadLlmRoles({ DOCMIND_CHAT_MODEL: "Not A Model!" })).toThrow(StartupConfigError);
  });
  it("accepts model ids with a colon (gemma4:31b-cloud)", () => {
    expect(envModelId({ X: "gemma4:31b-cloud" }, "X", "d")).toBe("gemma4:31b-cloud");
    expect(() => envModelId({ X: "bad id" }, "X", "d")).toThrow(/^X must be a model id$/);
  });
});

describe("loadLlmRoles hardening (203 review follow-ups)", () => {
  const msg = (env: Record<string, string>) => {
    try {
      loadLlmRoles(env);
    } catch (e) {
      return (e as Error).message;
    }
    return undefined;
  };
  it("rejects model ids with a slash, a newline, 101 chars or a URL", () => {
    for (const v of ["a/b", "gemma\nx", "a".repeat(101), "https://evil.example/m"])
      expect(msg({ DOCMIND_CHAT_MODEL: v })).toBe("DOCMIND_CHAT_MODEL must be a model id");
    expect(msg({ DOCMIND_CHAT_MODEL: "a".repeat(100) })).toBeUndefined();
  });
  it("never puts a value in an error (sentinels)", () => {
    const S = "sentinel-secret-value";
    const cases: Record<string, string>[] = [
      { DOCMIND_CHAT_MODEL: `${S}/x` },
      { DOCMIND_LLM_PROVIDER: S },
      { DOCMIND_SUMMARY_PROVIDER: S },
      { DOCMIND_GEMINI_THINKING_BUDGET: S },
      { DOCMIND_OLLAMA_URL: `ftp://${S}` },
      { DOCMIND_OLLAMA_URL: `http://user:${S}@host` },
      { ANTHROPIC_BASE_URL: `https://host/?k=${S}` },
      { GEMINI_BASE_URL: `https://host/#${S}` },
      { GEMINI_API_KEY: `${S}\nx` },
    ];
    for (const env of cases) {
      const m = msg(env);
      expect(m, JSON.stringify(Object.keys(env))).toBeDefined();
      expect(m).not.toContain(S);
    }
  });
  it("validates the three base URLs: http/https only, no credentials, no query, no fragment", () => {
    const vars = ["DOCMIND_OLLAMA_URL", "ANTHROPIC_BASE_URL", "GEMINI_BASE_URL"];
    for (const v of vars) {
      for (const u of [
        "ftp://h",
        "file:///x",
        "not a url",
        "http://u:p@h",
        "http://u@h",
        "https://h/?a=b",
        "https://h/#f",
      ])
        expect(msg({ [v]: u }), `${v} ${u.slice(0, 6)}`).toBe(
          `${v} must be an http or https URL without credentials, query or fragment`,
        );
      expect(msg({ [v]: "https://h.example/base" })).toBeUndefined();
      expect(msg({ [v]: "http://127.0.0.1:9" })).toBeUndefined();
    }
  });
  it("GEMINI_API_KEY must be header-safe, error names the variable only", () => {
    for (const k of ["a\nb", "a\rb", "a b\u0000", "k\u00e9y", "a\tb"])
      expect(msg({ GEMINI_API_KEY: k })).toBe("GEMINI_API_KEY must be a plain ASCII header value");
    expect(msg({ GEMINI_API_KEY: "test-key-not-real" })).toBeUndefined();
  });
  it("chat refused because of the shared DOCMIND_LLM_PROVIDER names that variable", () => {
    expect(msg({ DOCMIND_LLM_PROVIDER: "gemini", GEMINI_API_KEY: "test-key-not-real" })).toBe(
      "DOCMIND_LLM_PROVIDER cannot be gemini: the chat needs streaming",
    );
    expect(
      msg({
        DOCMIND_LLM_PROVIDER: "gemini",
        DOCMIND_CHAT_PROVIDER: "gemini",
        GEMINI_API_KEY: "test-key-not-real",
      }),
    ).toBe("DOCMIND_CHAT_PROVIDER cannot be gemini: the chat needs streaming");
  });
  it("DOCMIND_LLM_PROVIDER=off turns the PDF role off too", () => {
    const r = roles({ DOCMIND_LLM_PROVIDER: "off", GEMINI_API_KEY: "test-key-not-real" });
    expect(r.visionPdf).toEqual({ provider: "off", model: "" });
    expect(r.chat.provider).toBe("off");
  });
  it("shared=anthropic with an explicit DOCMIND_VISION_PDF_PROVIDER=gemini keeps Gemini for PDFs", () => {
    const r = roles({
      DOCMIND_LLM_PROVIDER: "anthropic",
      ANTHROPIC_API_KEY: "test-key-not-real",
      GEMINI_API_KEY: "test-key-not-real",
      DOCMIND_VISION_PDF_PROVIDER: "gemini",
    });
    expect(r.chat.provider).toBe("anthropic");
    expect(r.vision.provider).toBe("anthropic");
    expect(r.visionPdf).toEqual({ provider: "gemini", model: "gemini-3.5-flash" });
  });
  it("a bad DOCMIND_LLM_PROVIDER value is refused", () => {
    expect(msg({ DOCMIND_LLM_PROVIDER: "openai" })).toBe(
      "DOCMIND_LLM_PROVIDER must be one of anthropic, ollama, gemini, off",
    );
  });
});

describe("limits and warnings", () => {
  it("PDF caps follow the provider", () => {
    expect(pdfMaxBytes("anthropic")).toBe(22 * 1024 * 1024);
    expect(pdfMaxBytes("gemini")).toBe(14 * 1024 * 1024);
    expect(pdfMaxBytes("ollama")).toBe(0);
  });
  it("warns, in fixed text, about an unused Anthropic key and a plain-http remote URL, and about roles that are off", () => {
    const env = {
      ANTHROPIC_API_KEY: "test-key-not-real",
      DOCMIND_OLLAMA_URL: "http://203.0.113.9:11434",
    };
    const w = llmWarnings(loadLlmRoles(env), env);
    expect(w).toContain("ANTHROPIC_API_KEY is set but no role uses the anthropic provider");
    expect(w).toContain(
      "DOCMIND_OLLAMA_URL is plain http:// to a host that is not this machine: document text and questions travel unencrypted",
    );
    expect(w).toContain("scanned PDF pages are not read: DOCMIND_VISION_PDF_PROVIDER is off");
    expect(w.join("\n")).not.toContain("203.0.113.9");
  });
  it("warns about a plain-http remote Ollama even when no role uses it (embeddings always do)", () => {
    const env = {
      DOCMIND_LLM_PROVIDER: "anthropic",
      ANTHROPIC_API_KEY: "test-key-not-real",
      DOCMIND_OLLAMA_URL: "http://203.0.113.9:11434",
    };
    const w = llmWarnings(loadLlmRoles(env), env);
    expect(w.some((x) => x.startsWith("DOCMIND_OLLAMA_URL is plain http://"))).toBe(true);
    expect(w.join("\n")).not.toContain("203.0.113.9");
  });
  it("insecureUrlWarning warns for a remote host whatever the scheme case or trailing slash", () => {
    for (const u of ["HTTP://203.0.113.9:1", "http://203.0.113.9/", "Http://example.test/"])
      expect(insecureUrlWarning("V", u)).toMatch(/^V is plain http:\/\//);
  });
  it("loadLlmRoles accepts an uppercase scheme, an IPv6 loopback and a trailing slash", () => {
    const s = loadLlmRoles({ DOCMIND_OLLAMA_URL: "HTTP://[::1]:11434/" });
    expect(s.ollamaUrl).toBe("HTTP://[::1]:11434/");
  });
  it("insecureUrlWarning is silent for https, loopback and non-URLs", () => {
    for (const u of [
      "https://x.example",
      "http://127.0.0.1:1",
      "http://localhost",
      "http://[::1]:1",
      "http://[::1]/",
      "http://127.0.0.1:1/",
      "HTTP://LOCALHOST:11434",
      "HTTP://127.0.0.1:1",
      "HTTPS://x.example",
      "not a url",
      undefined,
    ])
      expect(insecureUrlWarning("V", u)).toBeUndefined();
  });
});
