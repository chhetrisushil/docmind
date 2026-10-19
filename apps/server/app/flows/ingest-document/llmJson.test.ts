import { LlmOutputError } from "@docmind/llm-anthropic";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { jsonAnswer } from "./llmJson";

const S = z.object({ a: z.string() });

describe("jsonAnswer", () => {
  it("parses a plain object, a fenced object and a fenced object without a language", () => {
    expect(jsonAnswer('{"a":"x"}', S)).toEqual({ a: "x" });
    expect(jsonAnswer('```json\n{"a":"x"}\n```', S)).toEqual({ a: "x" });
    expect(jsonAnswer('```\n{"a":"x"}\n```', S)).toEqual({ a: "x" });
  });

  it("refuses prose, two objects and a schema miss with LlmOutputError, never echoing the input", () => {
    for (const bad of ["SECRET-PROSE here", '{"a":"x"}{"a":"y"}', '{"b":"SECRET-VALUE"}']) {
      let err: unknown;
      try {
        jsonAnswer(bad, S);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(LlmOutputError);
      expect(String((err as Error).message)).not.toContain("SECRET");
    }
  });
});
