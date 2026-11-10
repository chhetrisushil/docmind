import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor, filterFingerprint } from "./cursor";

const row = {
  created_cursor: "2026-10-18T10:20:30.123456Z",
  id: "10000000-0000-4000-8000-000000000001",
};

describe("cursor", () => {
  it("round-trips and is URL-safe", () => {
    const token = encodeCursor(row);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(token)).toEqual({ t: row.created_cursor, i: row.id });
  });

  it("rejects anything that is not a cursor this server issued", () => {
    const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
    for (const bad of [
      "",
      "not base64 !!",
      enc({}),
      enc({ t: "yesterday", i: row.id }),
      enc({ t: "2026-13-45T10:20:30.123456Z", i: row.id }),
      enc({ t: "2026-02-30T10:20:30.123456Z", i: row.id }),
      enc({ t: "0000-01-01T00:00:00.000000Z", i: row.id }),
      enc({ t: row.created_cursor, i: "x'; DROP TABLE documents;--" }),
      enc({ t: row.created_cursor, i: row.id, extra: 1 }),
      enc([row.created_cursor, row.id]),
      "e30", // {}
    ]) {
      expect(decodeCursor(bad), bad).toBeNull();
    }
  });
});

describe("the filter fingerprint", () => {
  const row = {
    created_cursor: "2026-11-10T10:00:00.123456Z",
    id: "00000000-0000-4000-8000-000000000001",
  };
  const a = "00000000-0000-4000-8000-00000000000a";
  const b = "00000000-0000-4000-8000-00000000000b";
  it("is empty without a filter and 16 hex characters with one, whatever the id order or case", () => {
    expect(filterFingerprint(undefined)).toBe("");
    expect(filterFingerprint({ tagIds: [], match: "all" })).toBe("");
    const f = filterFingerprint({ tagIds: [a, b], match: "any" });
    expect(f).toMatch(/^[0-9a-f]{16}$/);
    expect(filterFingerprint({ tagIds: [b.toUpperCase(), a], match: "any" })).toBe(f);
    expect(filterFingerprint({ tagIds: [a, b], match: "all" })).not.toBe(f);
    expect(filterFingerprint({ tagIds: [a], match: "any" })).not.toBe(f);
  });
  it("treats match as any for a single tag", () => {
    expect(filterFingerprint({ tagIds: [a], match: "all" })).toBe(
      filterFingerprint({ tagIds: [a], match: "any" }),
    );
  });
  it("is carried in the cursor only when there is one, and an older cursor still decodes", () => {
    expect(decodeCursor(encodeCursor(row))).toEqual({ t: row.created_cursor, i: row.id });
    const f = filterFingerprint({ tagIds: [a], match: "any" });
    expect(decodeCursor(encodeCursor(row, f))).toEqual({ t: row.created_cursor, i: row.id, f });
    const forged = Buffer.from(
      JSON.stringify({ t: row.created_cursor, i: row.id, f: "zz" }),
    ).toString("base64url");
    expect(decodeCursor(forged)).toBeNull();
  });
});
