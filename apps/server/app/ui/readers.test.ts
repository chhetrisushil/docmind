import { describe, expect, it } from "vitest";
import { STATUS_MESSAGES } from "../status/model";
import { FIXED_ERROR, fixedError } from "./readers";

describe("the error a document shows to the UI", () => {
  it("is null, or one of the status model's fixed sentences, or a fixed fallback: never other text", () => {
    expect(fixedError(null)).toBeNull();
    for (const message of Object.values(STATUS_MESSAGES)) expect(fixedError(message)).toBe(message);
    expect(fixedError("ENOENT /var/blobs/quarterly-report.pdf for alice@example.com")).toBe(
      FIXED_ERROR,
    );
    expect(fixedError("")).toBe(FIXED_ERROR);
  });
});
