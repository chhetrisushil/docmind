import { describe, expect, it } from "vitest";
import { executionIdFor, subjectOfExecution } from "./subject";

const USER = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";

describe("erasure subject of an execution", () => {
  it("is the owning user for every execution that user owns", () => {
    expect(subjectOfExecution({ executionId: executionIdFor(USER, "ingest-1") })).toBe(USER);
    expect(subjectOfExecution({ executionId: executionIdFor(USER, "chat:2:x") })).toBe(USER);
    expect(subjectOfExecution({ executionId: `u_${USER}` })).toBe(USER);
  });

  it("is the execution itself when no user owns it", () => {
    for (const executionId of [
      "system-sweep",
      `x_${USER}:a`,
      "u_not-a-uuid:a",
      `u_${USER}x:a`,
      `u_${USER.toUpperCase()}:x`,
      `U_${USER}:x`,
    ]) {
      expect(subjectOfExecution({ executionId })).toBe(executionId);
    }
  });

  it("does not map an uppercase u_ prefix to the user", () => {
    expect(subjectOfExecution({ executionId: `U_${USER}:x` })).toBe(`U_${USER}:x`);
  });
});

describe("executionIdFor", () => {
  it("throws on a userId containing a separator", () => {
    expect(() => executionIdFor(`${USER}:evil`, "x")).toThrow(RangeError);
  });

  it("throws on a non-UUID userId", () => {
    expect(() => executionIdFor("not-a-uuid", "x")).toThrow(RangeError);
  });

  it("throws on an uppercase UUID userId", () => {
    expect(() => executionIdFor(USER.toUpperCase(), "x")).toThrow(RangeError);
  });

  it("throws on a name that makes the id over 1024 bytes", () => {
    expect(() => executionIdFor(USER, "x".repeat(1100))).toThrow(RangeError);
  });

  it("accepts a name that makes the id exactly 1024 bytes", () => {
    const name = "x".repeat(1024 - `u_${USER}:`.length);
    expect(Buffer.byteLength(executionIdFor(USER, name), "utf8")).toBe(1024);
  });

  it("round-trips through subjectOfExecution", () => {
    expect(subjectOfExecution({ executionId: executionIdFor(USER, "a:b:c") })).toBe(USER);
  });
});
