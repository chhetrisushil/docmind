import type { DocumentDto } from "@docmind/contracts";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PG_URL } from "../db/testSupport";
import { ALICE, type DocumentHarness, TEXT, startDocumentServer } from "./testHarness";

describe.skipIf(!PG_URL)(
  "deleting a document cancels its visualize executions (needs DOCMIND_TEST_PG_URL)",
  () => {
    let h: DocumentHarness;
    const visualCalls: string[] = [];
    let failVisuals = 0;
    let bumpOnIngestCancel = false;
    beforeAll(async () => {
      h = await startDocumentServer({
        deps: (deps) => ({
          ...deps,
          ingest: {
            ...deps.ingest,
            cancel: async (identity, documentId, generation) => {
              await deps.ingest.cancel(identity, documentId, generation);
              // A retry bumps the generation between the delete's first read and its transaction.
              if (bumpOnIngestCancel) {
                bumpOnIngestCancel = false;
                await h.owner.query(
                  "UPDATE documents SET ingest_generation = ingest_generation + 1 WHERE id = $1",
                  [documentId],
                );
              }
            },
          },
          visuals: {
            cancel: async (_identity, documentId, generation) => {
              visualCalls.push(`${documentId}:${generation}`);
              if (failVisuals > 0) {
                failVisuals--;
                throw new Error("synthetic-visuals-cancel-error");
              }
            },
          },
        }),
      });
    });
    afterAll(async () => h?.close());
    beforeEach(() => {
      vi.restoreAllMocks();
      visualCalls.length = 0;
    });

    const del = (id: string) =>
      fetch(`${h.base}/api/documents/${id}`, {
        method: "DELETE",
        headers: { "x-test-user": "alice" },
      });
    const create = async (name: string, bytes: Buffer) =>
      ((await (await h.upload("alice", name, bytes)).json()) as { document: DocumentDto }).document;
    const generationOf = async (id: string) =>
      Number(
        (await h.owner.query("SELECT ingest_generation FROM documents WHERE id = $1", [id])).rows[0]
          ?.ingest_generation,
      );
    const exists = async (id: string) =>
      (await h.owner.query("SELECT 1 FROM documents WHERE id = $1", [id])).rowCount === 1;

    it("cancels the visualize executions of the document's generation once, before it deletes", async () => {
      const doc = await create("v.txt", TEXT("visuals delete"));
      const generation = await generationOf(doc.id);
      expect((await del(doc.id)).status).toBe(204);
      expect(visualCalls).toEqual([`${doc.id}:${generation}`]);
      expect(await exists(doc.id)).toBe(false);
    });

    it("cancels again for a generation a retry bumped after the first cancel", async () => {
      const doc = await create("v2.txt", TEXT("visuals bump"));
      const generation = await generationOf(doc.id);
      bumpOnIngestCancel = true;
      expect((await del(doc.id)).status).toBe(204);
      expect(visualCalls).toEqual([`${doc.id}:${generation}`, `${doc.id}:${generation + 1}`]);
    });

    it("deletes nothing when the visualize cancel fails, and repeating the delete finishes the job", async () => {
      const doc = await create("v3.txt", TEXT("visuals fail"));
      failVisuals = 1;
      vi.spyOn(console, "error").mockImplementation(() => {}); // the route logs the failed handler
      expect((await del(doc.id)).status).toBeGreaterThanOrEqual(500);
      expect(await exists(doc.id)).toBe(true);
      expect((await del(doc.id)).status).toBe(204);
      expect(await exists(doc.id)).toBe(false);
      expect(visualCalls).toHaveLength(2);
    });

    it("another user's document is not cancelled for them", async () => {
      const doc = await create("v4.txt", TEXT("visuals mine"));
      const res = await fetch(`${h.base}/api/documents/${doc.id}`, {
        method: "DELETE",
        headers: { "x-test-user": "bob" },
      });
      expect(res.status).toBe(404);
      expect(visualCalls).toEqual([]);
      expect(ALICE.userId).toBeDefined();
      await del(doc.id);
    });
  },
);
