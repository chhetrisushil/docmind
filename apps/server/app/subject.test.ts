import { LINEAGE_STREAM_PREFIX } from "@loom-ui/lineage";
import { describe, expect, it } from "vitest";
import { legacyIds, opaqueIds } from "./opaqueIds";
import { testOpaqueIds } from "./opaqueIds/testing";
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

describe("erasure subject of a visuals lineage line", () => {
  const DOC = "d4d4d4d4-d4d4-4d4d-8d4d-d4d4d4d4d4d4";
  const P = "__loom_ui_lineage__:";

  it("is the owning user", () => {
    expect(subjectOfExecution({ executionId: `${P}visuals-${USER}-${DOC}` })).toBe(USER);
  });

  it("is no subject for any other lineage id", () => {
    for (const id of [
      "foo",
      `visuals-${USER}`,
      `visuals-${USER}-${DOC}x`,
      `visuals-${USER}-${DOC}:b`,
      `visuals-${USER.toUpperCase()}-${DOC}`,
      `xvisuals-${USER}-${DOC}`,
      `u_${USER}:visuals-${USER}-${DOC}`,
    ]) {
      expect(subjectOfExecution({ executionId: `${P}${id}` })).toBe("");
    }
  });

  it("owns a chat turn's visuals lineage line by its user, and refuses a malformed one", () => {
    const prefix = LINEAGE_STREAM_PREFIX;
    const chat = "c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3";
    expect(subjectOfExecution({ executionId: `${prefix}turnvisuals-${USER}-${chat}-6` })).toBe(
      USER,
    );
    expect(subjectOfExecution({ executionId: `${prefix}turnvisuals-${USER}-${chat}-0` })).toBe("");
    expect(subjectOfExecution({ executionId: `${prefix}turnvisuals-${USER}-${chat}` })).toBe("");
    expect(
      subjectOfExecution({ executionId: `${prefix}turnvisuals-${USER.toUpperCase()}-${chat}-6` }),
    ).toBe("");
  });
});

describe("erasure subject of a new-format id", () => {
  const T = "00000000-0000-0000-0000-0000000000aa";
  const DOC = "d4d4d4d4-d4d4-4d4d-8d4d-d4d4d4d4d4d4";
  const CHAT = "c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3";
  const P = "__loom_ui_lineage__:";

  it("is h_<handle> for every shape, with no key and no cache, and the user for the old shapes beside them", async () => {
    const t = testOpaqueIds();
    t.store.add(USER, T);
    const u = await t.ids.ensureUser({ tenantId: T, userId: USER });
    const subject = `h_${u.handle}`;
    expect(opaqueIds.current()).toBeUndefined(); // nothing installed: a cold process
    for (const executionId of [
      u.ingest(DOC, 2),
      `${u.ingest(DOC, 2)}::step#0`,
      u.visualize(DOC, 3, 2),
      u.suggestTags(DOC, 4),
      u.turnVisualize(CHAT, 9),
      u.chatTitle(CHAT),
      u.conversation(CHAT),
      `${u.conversation(CHAT)}~3`,
      `${P}${u.documentLineage(DOC)}`,
      `${P}${u.turnLineage(CHAT, 5)}`,
    ])
      expect(subjectOfExecution({ executionId })).toBe(subject);
    expect(subjectOfExecution({ executionId: legacyIds.ingest(USER, DOC, 2) })).toBe(USER);
    expect(subjectOfExecution({ executionId: `${P}${legacyIds.documentLineage(USER, DOC)}` })).toBe(
      USER,
    );
  });

  it("does not map a lookalike to a handle, and answers no subject for a bad lineage id", () => {
    const H = "a".repeat(26);
    const T52 = "q".repeat(52);
    for (const executionId of [
      `h_${H}x:ingest`,
      `h_${H.slice(1)}:ingest`,
      `h_${H.toUpperCase()}:x`,
      `h_${H}-c-x`,
      `H_${H}:x`,
    ])
      expect(subjectOfExecution({ executionId })).toBe(`x:${executionId}`);
    for (const id of [
      `visuals-${H}`,
      `visuals-${H}-${T52}x`,
      `visuals-${H.toUpperCase()}-${T52}`,
      `turnvisuals-${H}-${T52}`,
    ])
      expect(subjectOfExecution({ executionId: `${P}${id}` })).toBe("");
  });
});
