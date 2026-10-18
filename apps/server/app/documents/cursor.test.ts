import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor } from "./cursor";

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
