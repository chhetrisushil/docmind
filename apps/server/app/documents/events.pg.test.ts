import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PG_URL } from "../db/testSupport";
import { ingestRun } from "../status/testing";
import { type DocumentHarness, U1, openSse, startDocumentServer } from "./testHarness";

describe.skipIf(!PG_URL)(
  "document events beside the document routes (needs DOCMIND_TEST_PG_URL)",
  () => {
    let h: DocumentHarness;
    beforeAll(async () => {
      h = await startDocumentServer();
    });
    afterAll(async () => {
      await h.close();
    });

    it("is matched before the :id route, so 'events' is never treated as a document id", async () => {
      const res = await fetch(`${h.base}/api/documents/events`, {
        headers: { "x-test-user": "alice" },
      });
      expect([res.status, res.headers.get("content-type")]).toEqual([200, "text/event-stream"]);
      await res.body?.cancel();
    });

    it("delivers what the status model publishes after it has folded real log events", async () => {
      const mine = await openSse(`${h.base}/api/documents/events`, { "x-test-user": "alice" });
      expect(await mine.next()).toBe("retry: 5000");
      const documentId = randomUUID();
      for (const e of ingestRun(`u_${U1}:ingest-${documentId}.2`, "parsed")) h.status.onEvent(e);
      expect(await mine.next()).toBe(
        `id: 1\nevent: progress\ndata: ${JSON.stringify({ documentId, step: "parse", status: "parsing" })}`,
      );
      mine.close();
    });
  },
);
