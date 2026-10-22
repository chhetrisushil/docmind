import { describe, expect, it } from "vitest";
import { LlmAbortedError, LlmRequestError, LlmStreamError, LlmUnavailableError } from "./errors";

describe("retryable", () => {
  it("a request error is never retried, whatever built it", () => {
    expect((new LlmRequestError() as { retryable?: boolean }).retryable).toBe(false);
    expect((new LlmRequestError(400) as { retryable?: boolean }).retryable).toBe(false);
  });
  it("an unavailable error (and a broken stream) is retryable", () => {
    expect((new LlmUnavailableError(503) as { retryable?: boolean }).retryable).toBe(true);
    expect((new LlmStreamError() as { retryable?: boolean }).retryable).toBe(true);
  });
  it("an abort declares nothing", () => {
    expect((new LlmAbortedError() as { retryable?: boolean }).retryable).toBeUndefined();
  });
});
