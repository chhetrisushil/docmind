import { randomUUID } from "node:crypto";
import { RetryDocumentResponse } from "@docmind/contracts";
import type { ListDocumentsResponse } from "@docmind/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PG_URL } from "../db/testSupport";
import {
  type DocumentHarness,
  awaitTerminal,
  generationOf,
  getDoc,
  startDocumentServer,
  uploadAndAwaitTerminal,
} from "./testHarness";

// `PK\x03\x04` plus junk: the sniffer accepts it as docx, and the parse step then fails.
const BROKEN_DOCX = (tag: string) =>
  Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64, 7), Buffer.from(tag)]);

describe.skipIf(!PG_URL)("POST /api/documents/:id/retry (needs DOCMIND_TEST_PG_URL)", () => {
  let h: DocumentHarness;
  const cancels: { documentId: string; generation: number }[] = [];
  beforeAll(async () => {
    h = await startDocumentServer({
      // Records each cancel (document and generation) and delegates to the real port.
      deps: (d) => ({
        ...d,
        ingest: {
          start: (identity, documentId, generation) =>
            d.ingest.start(identity, documentId, generation),
          cancel: (identity, documentId, generation) => {
            cancels.push({ documentId, generation });
            return d.ingest.cancel(identity, documentId, generation);
          },
        },
      }),
    });
  });
  afterAll(async () => {
    await h?.close();
  });

  const retry = (user: string, id: string) =>
    fetch(`${h.base}/api/documents/${id}/retry`, {
      method: "POST",
      headers: { "x-test-user": user },
    });
  it("re-runs a failed document under its next generation, and again after it fails again", async () => {
    const id = await uploadAndAwaitTerminal(h, "alice", "broken.docx", BROKEN_DOCX("0"), "failed");
    const res = await retry("alice", id);
    expect(res.status).toBe(202);
    const body = RetryDocumentResponse.parse(await res.json());
    expect(body.document.status).toBe("uploaded");
    expect(await generationOf(h.owner, id)).toBe(3);
    await awaitTerminal(h, "alice", id, "failed"); // generation 3 ran and failed the same way
    expect((await retry("alice", id)).status).toBe(202);
    expect(await generationOf(h.owner, id)).toBe(4);
  });

  it("answers 409 not_failed for a document that is not failed, and leaves it alone", async () => {
    const id = await uploadAndAwaitTerminal(h, "alice", "ok.txt", "some text", "ready");
    const res = await retry("alice", id);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: { code: "not_failed", message: "the document has not failed" },
    });
    expect(await generationOf(h.owner, id)).toBe(2);
  });

  it("answers 404 for another user's document, for an unknown id and for a malformed id", async () => {
    const id = await uploadAndAwaitTerminal(h, "alice", "broken2.docx", BROKEN_DOCX("1"), "failed");
    expect((await retry("alice2", id)).status).toBe(404);
    expect((await retry("bob", id)).status).toBe(404);
    expect((await retry("alice", randomUUID())).status).toBe(404);
    expect((await retry("alice", "not-a-uuid")).status).toBe(404);
    expect(await generationOf(h.owner, id)).toBe(2);
  });

  it("lets exactly one of two concurrent retries win", async () => {
    const id = await uploadAndAwaitTerminal(h, "alice", "broken3.docx", BROKEN_DOCX("2"), "failed");
    const statuses = (await Promise.all([retry("alice", id), retry("alice", id)])).map(
      (r) => r.status,
    );
    expect(statuses.sort()).toEqual([202, 409]);
    expect(await generationOf(h.owner, id)).toBe(3);
  });

  it("restarts a failed document when the same bytes are uploaded again", async () => {
    const bytes = BROKEN_DOCX("dup");
    const id = await uploadAndAwaitTerminal(h, "alice", "dup.docx", bytes, "failed");
    const again = await h.upload("alice", "dup.docx", bytes);
    expect(again.status).toBe(200);
    const body = (await again.json()) as { document: { status: string }; duplicate: boolean };
    expect(body).toMatchObject({ duplicate: true, document: { status: "uploaded" } });
    expect(await generationOf(h.owner, id)).toBe(3);
  });

  it("at generation 3, shows uploaded despite the failed generation 2, and a delete cancels generations 2 and 3", async () => {
    const id = await uploadAndAwaitTerminal(h, "alice", "broken4.docx", BROKEN_DOCX("3"), "failed");
    // Hold generation 3's start, so the model has no event for it yet.
    h.ingest.holdStart();
    try {
      expect((await retry("alice", id)).status).toBe(202);
      expect(await generationOf(h.owner, id)).toBe(3);
      expect((await getDoc(h, "alice", id)).status).toBe("uploaded");
      const list = (await (
        await fetch(`${h.base}/api/documents`, { headers: { "x-test-user": "alice" } })
      ).json()) as ListDocumentsResponse;
      expect(list.items.find((d) => d.id === id)?.status).toBe("uploaded");
      h.ingest.releaseStart(); // the delete settles the pending start, then cancels
      const del = await fetch(`${h.base}/api/documents/${id}`, {
        method: "DELETE",
        headers: { "x-test-user": "alice" },
      });
      expect(del.status).toBe(204);
    } finally {
      h.ingest.releaseStart();
    }
    // The port is given generation 3; it cancels max(1, 3 - 1)..3 (ingest.test.ts pins the span).
    expect(cancels.filter((c) => c.documentId === id)).toEqual([{ documentId: id, generation: 3 }]);
  });
});
