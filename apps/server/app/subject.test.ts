import { describe, expect, it } from "vitest";
import { executionIdFor, subjectOfExecution } from "./subject";

const USER = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";

describe("erasure subject of an execution", () => {
  it("is the owning user for every execution that user owns", () => {
    expect(subjectOfExecution({ executionId: executionIdFor(USER, "ingest-1") })).toBe(USER);
    expect(subjectOfExecution({ executionId: executionIdFor(USER, "chat:2:x") })).toBe(USER);
    expect(subjectOfExecution({ executionId: `u_${USER}` })).toBe(USER);
  });

  it("is case-insensitive about the id, so one user never has two keys", () => {
    expect(subjectOfExecution({ executionId: `u_${USER.toUpperCase()}:x` })).toBe(USER);
  });

  it("is the execution itself when no user owns it", () => {
    for (const executionId of ["system-sweep", `x_${USER}:a`, "u_not-a-uuid:a", `u_${USER}x:a`]) {
      expect(subjectOfExecution({ executionId })).toBe(executionId);
    }
  });
});
