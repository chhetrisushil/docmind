import {
  LlmAbortedError,
  LlmOutputError,
  LlmRefusalError,
  LlmRequestError,
  LlmUnavailableError,
} from "@docmind/llm-anthropic";
import { ParseRejectedError } from "@docmind/parsers";
import { describe, expect, it } from "vitest";
import { FAILURE_CODES, PermanentIngestError, isAbort, isFatal, permanentCode } from "./errors";

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

describe("permanentCode of parser rejections", () => {
  it("records a parser's reject code, and a PermanentIngestError's code, as is", () => {
    for (const code of ["unsupported_content", "corrupt_content", "too_large"] as const)
      expect(permanentCode(new ParseRejectedError(code))).toBe(code);
    expect(permanentCode(new PermanentIngestError("vision_unavailable"))).toBe(
      "vision_unavailable",
    );
  });

  it("never records a code a parser may not produce: vision_unavailable belongs to the vision step", () => {
    expect(permanentCode(new ParseRejectedError("vision_unavailable" as never))).toBeUndefined();
    expect(permanentCode(new ParseRejectedError("something_else" as never))).toBeUndefined();
  });
});
