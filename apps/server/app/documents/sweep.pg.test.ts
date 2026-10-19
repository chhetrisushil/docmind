import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { FieldCrypto } from "../crypto/fields";
import { PG_URL } from "../db/testSupport";
import { StartScheduler } from "./startScheduler";
import { sweepStaleUploads } from "./sweep";
import { ALICE, BOB, seedDoc, startDocumentServer } from "./testHarness";

describe.skipIf(!PG_URL)("sweepStaleUploads (needs DOCMIND_TEST_PG_URL)", () => {
  it("starts each stale document, and a second sweep asks again but creates no second execution (start-once)", async () => {
    const h = await startDocumentServer();
    try {
      const fields = new FieldCrypto(h.keys);
      const ids = [
        await seedDoc(h.owner, h.app, fields, ALICE, "1".repeat(64), 600),
        await seedDoc(h.owner, h.app, fields, BOB, "2".repeat(64), 600),
      ];
      const args = {
        pool: h.app,
        starts: h.starts,
        olderThanMs: 120_000,
        lookbackMs: 604_800_000,
        limit: 10,
      };
      expect(await sweepStaleUploads(args)).toBe(2);
      await h.starts.idle();
      expect([...h.ingest.handles.keys()].sort()).toEqual([...ids].sort());
      const handles = [...h.ingest.handles.values()];
      await sweepStaleUploads(args); // the harness model is in memory, so the SQL still sees no rows; start-once protects
      await h.starts.idle();
      expect([...h.ingest.handles.values()]).toEqual(handles);
      expect(h.ingest.calls.filter((c) => c.startsWith("start:"))).toHaveLength(4); // asked twice, executed once
      await Promise.all(handles.map((handle) => handle.waitForCompletion()));
    } finally {
      await h.close();
    }
  });
});

describe("sweepStaleUploads failures", () => {
  it("warns by count only when the batch comes back full", async () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rows = [1, 2].map((n) => ({ tenant_id: "t", owner_id: "u", id: `secret-${n}` }));
    const pool = { query: async () => ({ rows }) } as unknown as Pool;
    const start = vi.fn(async () => null);
    const starts = new StartScheduler({ start, cancel: async () => {} });
    const args = { pool, starts, olderThanMs: 0, lookbackMs: 1 };
    await sweepStaleUploads({ ...args, limit: 3 });
    expect(spy).not.toHaveBeenCalled();
    await sweepStaleUploads({ ...args, limit: 2 });
    expect(spy.mock.calls).toEqual([["stale upload sweep batch was full", 2]]);
    spy.mockRestore();
  });

  it("a failing query is logged by class only and does not throw", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = {
      query: async () => {
        throw new RangeError("secret relation name");
      },
    } as unknown as Pool;
    const starts = new StartScheduler({ start: async () => null, cancel: async () => {} });
    expect(
      await sweepStaleUploads({ pool: broken, starts, olderThanMs: 0, lookbackMs: 1, limit: 1 }),
    ).toBe(0);
    expect(spy).toHaveBeenCalledWith("stale upload sweep failed", "RangeError");
    expect(JSON.stringify(spy.mock.calls)).not.toContain("secret");
    spy.mockRestore();
  });
});
