import type { AnthropicMessagesProvider } from "@docmind/llm-anthropic";
import { describe, expect, it } from "vitest";
import { loadLimits } from "../../documents/limits";
import { StartupConfigError } from "../../startupError";
import {
  createIngestWiring,
  loadEmbedConfig,
  loadGateLimits,
  loadLlmConfig,
  loadParseLimits,
  parseStepTimeoutMs,
} from "./limits";
import { STEP_TIMEOUT_MS } from "./stepEffect";

describe("loadParseLimits", () => {
  it("has defaults", () => {
    expect(loadParseLimits({})).toEqual({
      wallClockMs: 30_000,
      memoryMb: 512,
      maxInputBytes: 52_428_800,
      maxChars: 20_000_000,
    });
  });
  it("reads overrides", () => {
    expect(
      loadParseLimits({ DOCMIND_PARSE_TIMEOUT_MS: "5000", DOCMIND_PARSE_MEMORY_MB: "128" }),
    ).toMatchObject({ wallClockMs: 5000, memoryMb: 128 });
  });
  it.each([
    ["DOCMIND_PARSE_TIMEOUT_MS", "0"],
    ["DOCMIND_PARSE_MEMORY_MB", "-1"],
    ["DOCMIND_PARSE_MAX_CHARS", "abc"],
    ["DOCMIND_MAX_UPLOAD_BYTES", "1.5"],
  ])("rejects %s=%s naming the variable but not the value", (name, value) => {
    expect(() => loadParseLimits({ [name]: value })).toThrow(
      new RegExp(`^${name} must be a positive integer$`),
    );
  });
  it.each([
    ["DOCMIND_PARSE_TIMEOUT_MS", "600001", 600000],
    ["DOCMIND_PARSE_MEMORY_MB", "8193", 8192],
    ["DOCMIND_PARSE_MAX_CHARS", "100000001", 100000000],
  ])("rejects %s=%s over its bound without echoing the value", (name, value, max) => {
    expect(() => loadParseLimits({ [name]: value })).toThrow(
      new RegExp(`^${name} must be at most ${max}$`),
    );
  });
});

describe("maxInputBytes", () => {
  it.each([{}, { DOCMIND_MAX_UPLOAD_BYTES: "1234567" }])("equals the upload limit (%j)", (env) => {
    expect(loadParseLimits(env).maxInputBytes).toBe(loadLimits(env).maxFileBytes);
  });
  it("refuses an upload limit over the ceiling with the upload loader's message", () => {
    expect(() => loadParseLimits({ DOCMIND_MAX_UPLOAD_BYTES: "268435457" })).toThrow(
      /^DOCMIND_MAX_UPLOAD_BYTES must be at most 268435456/,
    );
  });
});

describe("createIngestWiring", () => {
  it("builds a registry with the default parsers, a runner and a bus", () => {
    const w = createIngestWiring({});
    expect(w.registry.ids()).toEqual(["txt", "md", "org", "docx", "doc", "pdf"]);
    expect(w.runner.active()).toBe(0);
  });

  it.each(["1.5", "0", "abc"])(
    "rejects DOCMIND_PARSE_CONCURRENCY=%s naming the variable but not the value",
    (value) => {
      expect(() => createIngestWiring({ DOCMIND_PARSE_CONCURRENCY: value })).toThrow(
        /^DOCMIND_PARSE_CONCURRENCY must be a positive integer$/,
      );
    },
  );

  it("rejects DOCMIND_PARSE_CONCURRENCY over its bound", () => {
    expect(() => createIngestWiring({ DOCMIND_PARSE_CONCURRENCY: "17" })).toThrow(
      /^DOCMIND_PARSE_CONCURRENCY must be at most 16$/,
    );
  });
});

describe("loadEmbedConfig", () => {
  it("has defaults", () => {
    expect(loadEmbedConfig({})).toEqual({
      baseUrl: "http://127.0.0.1:11434",
      model: "nomic-embed-text",
      dimensions: 768,
      timeoutMs: 30_000,
    });
  });
  it("reads overrides", () => {
    expect(
      loadEmbedConfig({
        DOCMIND_OLLAMA_URL: "http://127.0.0.1:9",
        DOCMIND_EMBED_MODEL: "m",
        DOCMIND_EMBED_DIMENSIONS: "8",
      }),
    ).toMatchObject({ baseUrl: "http://127.0.0.1:9", model: "m", dimensions: 8 });
  });
  it.each([
    ["DOCMIND_EMBED_DIMENSIONS", "0"],
    ["DOCMIND_EMBED_TIMEOUT_MS", "abc"],
  ])("rejects %s=%s naming the variable and not the value", (name, value) => {
    expect(() => loadEmbedConfig({ [name]: value })).toThrow(
      new RegExp(`^${name} must be a positive integer$`),
    );
  });
  it.each([
    ["DOCMIND_EMBED_DIMENSIONS", "16001"],
    ["DOCMIND_EMBED_TIMEOUT_MS", String(STEP_TIMEOUT_MS)],
  ])("bounds %s", (name, value) => {
    expect(() => loadEmbedConfig({ [name]: value })).toThrow(
      new RegExp(`^${name} must be at most \\d+$`),
    );
  });
});

describe("DOCMIND_EMBED_TIMEOUT_MS against the per-attempt bound", () => {
  it("accepts the largest value below STEP_TIMEOUT_MS", () => {
    expect(
      loadEmbedConfig({ DOCMIND_EMBED_TIMEOUT_MS: String(STEP_TIMEOUT_MS - 1) }).timeoutMs,
    ).toBe(STEP_TIMEOUT_MS - 1);
  });
  it("rejects a value that cannot fire before the attempt is cut off, naming the variable", () => {
    expect(() => loadEmbedConfig({ DOCMIND_EMBED_TIMEOUT_MS: "600000" })).toThrow(
      new StartupConfigError(`DOCMIND_EMBED_TIMEOUT_MS must be at most ${STEP_TIMEOUT_MS - 1}`),
    );
  });
});

describe("createIngestWiring embedder", () => {
  it("builds the embedder from the configuration", () => {
    const { embedder } = createIngestWiring({
      DOCMIND_EMBED_MODEL: "m",
      DOCMIND_EMBED_DIMENSIONS: "8",
    });
    expect(embedder).toMatchObject({ modelId: "ollama/m", dimensions: 8 });
  });
  it("fails startup on a bad URL with a StartupConfigError naming the variable, never the value", () => {
    const run = () => createIngestWiring({ DOCMIND_OLLAMA_URL: "http://user:hunter2@host:1" });
    expect(run).toThrow(StartupConfigError);
    expect(run).toThrow(/^DOCMIND_OLLAMA_URL must be an http\(s\) URL/);
    expect(run).not.toThrow(/hunter2/);
  });
});

describe("loadGateLimits", () => {
  it("has defaults", () => {
    expect(loadGateLimits({})).toEqual({ concurrency: 4, tenantConcurrency: 2 });
  });
  it("reads overrides", () => {
    expect(
      loadGateLimits({
        DOCMIND_INGEST_CONCURRENCY: "8",
        DOCMIND_INGEST_TENANT_CONCURRENCY: "3",
      }),
    ).toEqual({ concurrency: 8, tenantConcurrency: 3 });
  });
  it("refuses a tenant cap above the global cap, naming both variables", () => {
    expect(() => loadGateLimits({ DOCMIND_INGEST_TENANT_CONCURRENCY: "5" })).toThrow(
      new StartupConfigError(
        "DOCMIND_INGEST_TENANT_CONCURRENCY must not exceed DOCMIND_INGEST_CONCURRENCY",
      ),
    );
  });
  it.each([
    ["DOCMIND_INGEST_CONCURRENCY", "abc"],
    ["DOCMIND_INGEST_CONCURRENCY", "65"],
    ["DOCMIND_INGEST_TENANT_CONCURRENCY", "0"],
  ])("rejects %s=%s naming the variable", (name, value) => {
    expect(() => loadGateLimits({ [name]: value })).toThrow(new RegExp(name));
  });
  it("is built into the wiring", () => {
    expect(createIngestWiring({}).gate.active).toBe(0);
  });
});

describe("parseStepTimeoutMs", () => {
  it("covers a slot wait, the run itself, and 30s of slack", () => {
    expect(parseStepTimeoutMs({ ...loadParseLimits({}), wallClockMs: 30_000 })).toBe(90_000);
  });
});

describe("LLM config and providers", () => {
  it("loads LLM config with defaults and no providers when the key is unset or blank", () => {
    for (const env of [{}, { ANTHROPIC_API_KEY: "   " }]) {
      const w = createIngestWiring(env);
      expect(w.llm.summary).toBeUndefined();
      expect(w.llm.vision).toBeUndefined();
      expect(w.llm.config).toMatchObject({
        summaryModel: "claude-haiku-5-5",
        visionModel: "claude-sonnet-5-5",
        timeoutMs: 60_000,
      });
    }
  });

  it("builds both providers with their own models when the key is set", () => {
    const w = createIngestWiring({
      ANTHROPIC_API_KEY: "k-test",
      DOCMIND_SUMMARY_MODEL: "claude-x-1",
    });
    expect((w.llm.summary as AnthropicMessagesProvider).model).toBe("claude-x-1");
    expect((w.llm.vision as AnthropicMessagesProvider).model).toBe("claude-sonnet-5-5");
  });

  it("names the variable, never the value, for a bad model id, timeout, base URL or key", () => {
    expect(() => loadLlmConfig({ DOCMIND_SUMMARY_MODEL: "bad model!" })).toThrow(
      /^DOCMIND_SUMMARY_MODEL must be a model id$/,
    );
    expect(() => loadLlmConfig({ DOCMIND_LLM_TIMEOUT_MS: "0" })).toThrow(/DOCMIND_LLM_TIMEOUT_MS/);
    expect(() =>
      createIngestWiring({ ANTHROPIC_API_KEY: "k", ANTHROPIC_BASE_URL: "http://u:SECRETPW@h" }),
    ).toThrow(
      /^ANTHROPIC_BASE_URL must be an http\(s\) URL without credentials, query or fragment$/,
    );
    expect(() => createIngestWiring({ ANTHROPIC_API_KEY: "bad\nkey" })).toThrow(
      /^ANTHROPIC_API_KEY must be a header-safe string$/,
    );
  });
});
