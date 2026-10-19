import { describe, expect, it } from "vitest";
import { createIngestWiring, loadParseLimits } from "./limits";

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
    ["DOCMIND_PARSE_TIMEOUT_MS", "2147483648", 2147483647],
    ["DOCMIND_PARSE_MEMORY_MB", "999999", 65536],
    ["DOCMIND_PARSE_MAX_CHARS", "100000001", 100000000],
    ["DOCMIND_MAX_UPLOAD_BYTES", "268435457", 268435456],
  ])("rejects %s=%s over its bound without echoing the value", (name, value, max) => {
    expect(() => loadParseLimits({ [name]: value })).toThrow(
      new RegExp(`^${name} must be at most ${max}$`),
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
    expect(() => createIngestWiring({ DOCMIND_PARSE_CONCURRENCY: "65" })).toThrow(
      /^DOCMIND_PARSE_CONCURRENCY must be at most 64$/,
    );
  });
});
