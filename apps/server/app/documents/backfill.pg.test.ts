import { describe, expect, it } from "vitest";
import { FieldCrypto } from "../crypto/fields";
import { PG_URL } from "../db/testSupport";
import { runBackfill } from "./backfill";
import { ingestExecutionId } from "./ingest";
import { ALICE, U1, seedDoc, seedRow, startDocumentServer } from "./testHarness";

const DAY = 86_400;

describe.skipIf(!PG_URL)("runBackfill (needs DOCMIND_TEST_PG_URL)", () => {
  it("starts a 30-day-old document only when the lookback reaches it, and not again once it has a status row", async () => {
    const h = await startDocumentServer();
    try {
      const fields = new FieldCrypto(h.keys);
      const doc = await seedDoc(h.owner, h.app, fields, ALICE, "4".repeat(64), 30 * DAY);
      expect(await runBackfill(h.app, h.starts, { lookbackDays: 7 })).toBe(0);
      expect(h.ingest.calls).toEqual([]);
      expect(await runBackfill(h.app, h.starts, { lookbackDays: 60 })).toBe(1);
      expect(h.ingest.calls).toEqual([`start:${doc}`]);
      await h.starts.finished();
      // The harness's status model is in memory; store the row the real writer would have.
      await seedRow(h.owner, ingestExecutionId(U1, doc), doc, U1);
      expect(await runBackfill(h.app, h.starts, { lookbackDays: 60 })).toBe(0);
      expect(h.ingest.calls).toEqual([`start:${doc}`]);
    } finally {
      await h.close();
    }
  });
});
