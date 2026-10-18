import { existsSync } from "node:fs";
import { join } from "node:path";
import type { DocumentDto } from "@docmind/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PG_URL } from "../db/testSupport";
import { type DocumentHarness, T1, TEXT, U1, startDocumentServer } from "./testHarness";

describe.skipIf(!PG_URL)("DELETE /api/documents/:id (needs DOCMIND_TEST_PG_URL)", () => {
  let h: DocumentHarness;
  beforeAll(async () => {
    h = await startDocumentServer();
  });
  afterAll(async () => {
    await h?.close();
  });

  const del = (id: string, user = "alice") =>
    fetch(`${h.base}/api/documents/${id}`, { method: "DELETE", headers: { "x-test-user": user } });
  const create = async (name: string, bytes: Buffer, user = "alice") =>
    ((await (await h.upload(user, name, bytes)).json()) as { document: DocumentDto }).document;
  const rows = async (id: string) =>
    (await h.owner.query("SELECT count(*)::int AS n FROM documents WHERE id = $1", [id])).rows[0]
      .n as number;
  const blobPath = async (bytes: Buffer) =>
    join(h.root, T1, U1, await h.fingerprint("alice", bytes));
  const cancels = (id: string) => h.ingest.calls.filter((c) => c === `cancel:${id}`);

  it("hard-deletes the row and the blob, then answers 404 the second time", async () => {
    const bytes = TEXT("delete me");
    const doc = await create("a.txt", bytes);
    expect(existsSync(await blobPath(bytes))).toBe(true);
    expect((await del(doc.id)).status).toBe(204);
    expect(await rows(doc.id)).toBe(0);
    expect(existsSync(await blobPath(bytes))).toBe(false);
    expect((await del(doc.id)).status).toBe(404);
  });

  it("will not delete a colleague's or another tenant's document, and cancels nothing for them", async () => {
    const mine = await create("mine.txt", TEXT("colleague-owned"), "alice2");
    const before = h.ingest.calls.length;
    expect((await del(mine.id, "alice")).status).toBe(404);
    expect((await del(mine.id, "bob")).status).toBe(404);
    expect(await rows(mine.id)).toBe(1);
    expect((await del("not-a-uuid")).status).toBe(404);
    expect(h.ingest.calls.length).toBe(before);
    expect((await fetch(`${h.base}/api/documents/${mine.id}`, { method: "DELETE" })).status).toBe(
      401,
    );
  });

  it("lets the same bytes be uploaded again afterwards as a new document with its own execution", async () => {
    const bytes = TEXT("round trip");
    const first = await create("a.txt", bytes);
    await del(first.id);
    const res = await h.upload("alice", "a.txt", bytes);
    expect(res.status).toBe(201);
    const second = ((await res.json()) as { document: DocumentDto }).document;
    expect(second.id).not.toBe(first.id);
    expect(existsSync(await blobPath(bytes))).toBe(true);
    expect(h.ingest.handles.has(second.id)).toBe(true);
  });

  it("cancels the flow first: a delete during an in-flight flow cancels it, and the step that was running finds nothing", async () => {
    h.ingest.hold(); // the stub step waits before it looks the document up
    const bytes = TEXT("in flight");
    const doc = await create("busy.txt", bytes);
    const handle = h.ingest.handles.get(doc.id);
    expect(handle).toBeDefined();
    try {
      // runtime.cancel marks the live run cancelled and returns; it does not wait for the held step.
      expect((await del(doc.id)).status).toBe(204);
    } finally {
      h.ingest.release(); // always let the held step go, so a failure cannot hang the suite
    }
    expect(cancels(doc.id)).toHaveLength(1);
    expect(await rows(doc.id)).toBe(0);
    expect(existsSync(await blobPath(bytes))).toBe(false);
    await expect(handle?.waitForCompletion()).rejects.toThrow(/cancel/i);
    expect(handle?.getState().status).toBe("cancelled");
  });

  it("cancels before it deletes: if the cancel fails nothing is deleted, and repeating the delete finishes the job", async () => {
    const bytes = TEXT("cancel fails once");
    const doc = await create("c.txt", bytes);
    h.ingest.failNext("cancel");
    expect((await del(doc.id)).status).toBe(500);
    expect(await rows(doc.id)).toBe(1);
    expect(existsSync(await blobPath(bytes))).toBe(true);

    expect((await del(doc.id)).status).toBe(204);
    expect(await rows(doc.id)).toBe(0);
    expect(existsSync(await blobPath(bytes))).toBe(false);
    expect(cancels(doc.id)).toHaveLength(2); // the failed attempt and the retry
    expect((await del(doc.id)).status).toBe(404);
    expect(cancels(doc.id)).toHaveLength(2); // a third delete cancels nothing
  });

  it("deletes a document whose flow already finished, and one whose flow never started", async () => {
    const done = await create("done.txt", TEXT("finished flow"));
    await h.ingest.handles.get(done.id)?.waitForCompletion();
    expect((await del(done.id)).status).toBe(204);

    h.ingest.failNext("start"); // upload commits, the flow never starts
    const orphan = await create("never.txt", TEXT("never started"));
    expect(h.ingest.handles.has(orphan.id)).toBe(false);
    expect((await del(orphan.id)).status).toBe(204);
    expect(await rows(orphan.id)).toBe(0);
  });

  it("canonicalizes an upper-case id: the flow is cancelled by the row's id, and the row and blob are gone", async () => {
    h.ingest.hold();
    const bytes = TEXT("upper case id");
    const doc = await create("upper.txt", bytes);
    const handle = h.ingest.handles.get(doc.id);
    try {
      expect((await del(doc.id.toUpperCase())).status).toBe(204);
    } finally {
      h.ingest.release();
    }
    expect(cancels(doc.id)).toHaveLength(1);
    expect(h.ingest.calls).not.toContain(`cancel:${doc.id.toUpperCase()}`);
    expect(await rows(doc.id)).toBe(0);
    expect(existsSync(await blobPath(bytes))).toBe(false);
    await expect(handle?.waitForCompletion()).rejects.toThrow(/cancel/i);
    expect(handle?.getState().status).toBe("cancelled");
  });
});
