import type { DocumentDto, ListDocumentsResponse } from "@docmind/contracts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FieldCrypto } from "../crypto/fields";
import { withTenant } from "../db/tenant";
import { PG_URL } from "../db/testSupport";
import { INGEST_STATUS_MODEL, STATUS_MESSAGES } from "../status/model";
import { ingestRun } from "../status/testing";
import { insertDocument } from "./repo";
import {
  ALICE,
  BOB,
  type DocumentHarness,
  TEXT,
  U1,
  newDocument,
  startDocumentServer,
} from "./testHarness";

describe.skipIf(!PG_URL)(
  "document status comes from the ingest-status model (needs DOCMIND_TEST_PG_URL)",
  () => {
    let h: DocumentHarness;
    beforeAll(async () => {
      h = await startDocumentServer();
    });
    afterAll(async () => {
      await h?.close();
    });

    /** A document row with no flow running for it, so a test decides what the model knows. */
    const seed = async (who: typeof ALICE, fingerprint: string) => {
      const doc = await newDocument(new FieldCrypto(h.keys), who.tenantId, who.userId, fingerprint);
      await withTenant(h.app, who.tenantId, (tx) => insertDocument(tx, doc));
      return doc.id;
    };
    /** Feed the model the way Loom's onEvent does. */
    const feed = async (who: typeof ALICE, id: string, spec: Parameters<typeof ingestRun>[1]) => {
      for (const e of ingestRun(`u_${who.userId}:ingest-${id}.2`, spec)) h.status.onEvent(e);
      await h.status.close();
    };
    const json = async (user: string, path: string) =>
      (await fetch(`${h.base}${path}`, { headers: { "x-test-user": user } })).json();
    const del = (id: string) =>
      fetch(`${h.base}/api/documents/${id}`, {
        method: "DELETE",
        headers: { "x-test-user": "alice" },
      });

    it("lists each document's status and failure message from the model, and uploaded for one with no row", async () => {
      const fresh = await seed(ALICE, "1".repeat(64));
      const parsing = await seed(ALICE, "2".repeat(64));
      const failed = await seed(ALICE, "3".repeat(64));
      const bobs = await seed(BOB, "4".repeat(64));
      await feed(ALICE, parsing, "parsed");
      await feed(ALICE, failed, "failed:corrupt_content");
      await feed(BOB, bobs, "ready");
      const by = new Map(
        ((await json("alice", "/api/documents")) as ListDocumentsResponse).items.map((d) => [
          d.id,
          d,
        ]),
      );
      expect([fresh, parsing, failed].map((id) => [by.get(id)?.status, by.get(id)?.error])).toEqual(
        [
          ["uploaded", null],
          ["parsing", null],
          ["failed", STATUS_MESSAGES.corrupt_content],
        ],
      );
      expect(by.has(bobs)).toBe(false);
    });

    it("shows the same status on GET /api/documents/:id, and a 404 to another user", async () => {
      const id = await seed(ALICE, "5".repeat(64));
      await feed(ALICE, id, "ready");
      expect(await json("alice", `/api/documents/${id}`)).toMatchObject({
        id,
        status: "ready",
        error: null,
      });
      const foreign = await fetch(`${h.base}/api/documents/${id}`, {
        headers: { "x-test-user": "bob" },
      });
      expect(foreign.status).toBe(404);
    });

    it("answers a fresh upload as uploaded with no error", async () => {
      const body = (await (await h.upload("alice", "n.txt", TEXT("fresh status"))).json()) as {
        document: DocumentDto;
      };
      expect([body.document.status, body.document.error]).toEqual(["uploaded", null]);
    });

    it("deleting a document tombstones its status rows", async () => {
      const id = await seed(ALICE, "6".repeat(64));
      await feed(ALICE, id, "ready");
      expect((await del(id)).status).toBe(204);
      const [row] = await h.statusStore.getFolded(INGEST_STATUS_MODEL, [`u_${U1}:ingest-${id}.2`]);
      expect(row).toMatchObject({ erased: true, state: null });
      expect((await h.status.forPage(ALICE, [id])).size).toBe(0);
    });

    it("answers 204 and leaves no document when forgetting its status fails after the delete committed (F18)", async () => {
      const id = await seed(ALICE, "7".repeat(64));
      await feed(ALICE, id, "ready");
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      const purge = vi
        .spyOn(h.statusStore, "purgeFolded")
        .mockRejectedValueOnce(new RangeError("store down"));
      expect((await del(id)).status).toBe(204);
      expect(purge).toHaveBeenCalledTimes(1);
      const gone = await fetch(`${h.base}/api/documents/${id}`, {
        headers: { "x-test-user": "alice" },
      });
      expect(gone.status).toBe(404);
      expect(spy).toHaveBeenCalledWith(
        "forget document status failed",
        "RangeError",
        "DELETE /api/documents/:id",
      );
      expect(JSON.stringify(spy.mock.calls)).not.toContain("store down");
      vi.restoreAllMocks();
    });
  },
);
