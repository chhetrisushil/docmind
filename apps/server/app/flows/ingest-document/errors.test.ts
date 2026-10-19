import {
  LlmAbortedError,
  LlmOutputError,
  LlmRefusalError,
  LlmRequestError,
  LlmUnavailableError,
} from "@docmind/llm-anthropic";
import { describe, expect, it } from "vitest";
import { FAILURE_CODES, isAbort, isFatal, permanentCode } from "./errors";

describe("LLM error classification", () => {
  it("classifies LLM errors: request and refusal are fatal, abort is an abort, unavailable and output are retried", () => {
    expect(isFatal(new LlmRequestError(404))).toBe(true);
    expect(isFatal(new LlmRefusalError())).toBe(true);
    expect(isAbort(new LlmAbortedError())).toBe(true);
    for (const e of [new LlmUnavailableError(529), new LlmOutputError()]) {
      expect(isFatal(e)).toBe(false);
      expect(isAbort(e)).toBe(false);
      expect(permanentCode(e)).toBeUndefined();
    }
  });

  it("lists vision_unavailable as a failure code", () => {
    expect(FAILURE_CODES).toContain("vision_unavailable");
  });
});
