import { describe, expect, it } from "vitest";
import { executionIdFor, subjectOfExecution } from "./subject";

const USER = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";

describe("erasure subject of an execution", () => {
  it("is the owning user for every execution that user owns", () => {
    expect(subjectOfExecution({ executionId: executionIdFor(USER, "ingest-1") })).toBe(USER);
    expect(subjectOfExecution({ executionId: executionIdFor(USER, "chat:2:x") })).toBe(USER);
    expect(subjectOfExecution({ executionId: `u_${USER}` })).toBe(USER);
  });

  it("is the owning user for a chat conversation and every generation of it", () => {
    const chat = "c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3";
    expect(subjectOfExecution({ executionId: `u_${USER}.c-${chat}` })).toBe(USER);
    expect(subjectOfExecution({ executionId: `u_${USER}.c-${chat}~4` })).toBe(USER);
  });

  it("is the owning user for the inbox stream of a chat conversation, and only of one", () => {
    const chat = "c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3";
    expect(subjectOfExecution({ executionId: `__loom_inbox__:u_${USER}.c-${chat}` })).toBe(USER);
    for (const executionId of [
      `__loom_inbox__:u_${USER}`,
      `__loom_inbox__:u_${USER}:x`,
      `__loom_inbox__:x_${USER}.c-${chat}`,
      `__loom_inbox__: u_${USER}.c-${chat}`,
    ]) {
      expect(subjectOfExecution({ executionId })).toBe(`x:${executionId}`);
    }
  });

  it("does not map a lookalike of the chat separator to the user", () => {
    for (const executionId of [`u_${USER}.d-x`, `u_${USER}.c`, `u_${USER}-c-x`, `u_${USER}x.c-y`]) {
      expect(subjectOfExecution({ executionId })).toBe(`x:${executionId}`);
    }
  });

  it("is an x: key, outside the user namespace, when no user owns it", () => {
    for (const executionId of [
      "system-sweep",
      `x_${USER}:a`,
      "u_not-a-uuid:a",
      `u_${USER}x:a`,
      `u_${USER.toUpperCase()}:x`,
    ]) {
      expect(subjectOfExecution({ executionId })).toBe(`x:${executionId}`);
    }
  });

  it("does not map an execution whose id is exactly a user's UUID to that user", () => {
    expect(subjectOfExecution({ executionId: USER })).toBe(`x:${USER}`);
  });

  it("does not map an uppercase u_ prefix to the user", () => {
    expect(subjectOfExecution({ executionId: `U_${USER}:x` })).toBe(`x:U_${USER}:x`);
  });

  it("anchors the match at the start: a prefixed id does not map to the user", () => {
    expect(subjectOfExecution({ executionId: `sys:u_${USER}:x` })).toBe(`x:sys:u_${USER}:x`);
  });

  it("anchors the match at the start: a leading space does not map to the user", () => {
    expect(subjectOfExecution({ executionId: ` u_${USER}:x` })).toBe(`x: u_${USER}:x`);
  });
});

describe("executionIdFor", () => {
  it("throws on a userId containing a separator", () => {
    expect(() => executionIdFor(`${USER}:evil`, "x")).toThrow(RangeError);
  });

  it("throws on a non-UUID userId", () => {
    expect(() => executionIdFor("not-a-uuid", "x")).toThrow(RangeError);
  });

  it("throws on a userId with leading characters before a UUID", () => {
    expect(() => executionIdFor(`zz${USER}`, "x")).toThrow(RangeError);
  });

  it("throws on an uppercase UUID userId", () => {
    expect(() => executionIdFor(USER.toUpperCase(), "x")).toThrow(RangeError);
  });

  it("throws on a name that makes the id over 1024 bytes", () => {
    expect(() => executionIdFor(USER, "x".repeat(1100))).toThrow(RangeError);
  });

  it("throws on a name under 1024 characters but over 1024 UTF-8 bytes", () => {
    const name = "é".repeat(600);
    expect(name.length).toBeLessThan(1024);
    expect(() => executionIdFor(USER, name)).toThrow(RangeError);
  });

  it("accepts a name that makes the id exactly 1024 bytes", () => {
    const name = "x".repeat(1024 - `u_${USER}:`.length);
    expect(Buffer.byteLength(executionIdFor(USER, name), "utf8")).toBe(1024);
  });

  it("round-trips through subjectOfExecution", () => {
    expect(subjectOfExecution({ executionId: executionIdFor(USER, "a:b:c") })).toBe(USER);
  });

  it("keeps the user for Loom's :: children and ~n continue-as-new successors", () => {
    const parent = executionIdFor(USER, "ingest-1");
    for (const executionId of [`${parent}::step#0`, `${parent}::a::b#2`, `${parent}~1`]) {
      expect(subjectOfExecution({ executionId })).toBe(USER);
    }
  });
});
