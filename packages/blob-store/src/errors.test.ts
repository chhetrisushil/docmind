import { describe, expect, it } from "vitest";
import { BlobCorruptError, BlobKeyUnavailableError, BlobTooLargeError } from "./errors";

describe("blob errors", () => {
  it("are Error subclasses with their class name", () => {
    const errors = [
      new BlobCorruptError(),
      new BlobTooLargeError(1024),
      new BlobKeyUnavailableError(),
    ];
    for (const e of errors) {
      expect(e).toBeInstanceOf(Error);
      expect(e.name).toBe(e.constructor.name);
    }
  });

  it("BlobCorruptError defaults its message", () => {
    expect(new BlobCorruptError().message).toBe("blob failed authentication");
  });

  it("BlobTooLargeError exposes maxBytes and a sized message", () => {
    const e = new BlobTooLargeError(1024);
    expect(e.maxBytes).toBe(1024);
    expect(e.message).toBe("blob exceeds the 1024-byte limit");
  });

  it("BlobKeyUnavailableError has a fixed message", () => {
    expect(new BlobKeyUnavailableError().message).toBe(
      "the data key for this blob's owner is unavailable",
    );
  });
});
