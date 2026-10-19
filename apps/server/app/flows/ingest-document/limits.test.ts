import { describe, expect, it } from "vitest";
import { loadLimits } from "../../documents/limits";
import { StartupConfigError } from "../../startupError";
import { createIngestWiring, loadEmbedConfig, loadParseLimits } from "./limits";

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
  it("builds a registry with the txt parser, a runner and a bus", () => {
    const w = createIngestWiring({});
    expect(w.registry.ids()).toEqual(["txt"]);
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
    ["DOCMIND_EMBED_TIMEOUT_MS", "600001"],
  ])("bounds %s", (name, value) => {
    expect(() => loadEmbedConfig({ [name]: value })).toThrow(
      new RegExp(`^${name} must be at most \\d+$`),
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
