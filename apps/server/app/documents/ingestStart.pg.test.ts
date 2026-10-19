import type { DocumentDto, UploadDocumentResponse } from "@docmind/contracts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PG_URL } from "../db/testSupport";
import { ingestExecutionId } from "./ingest";
import { type DocumentHarness, TEXT, U1, startDocumentServer } from "./testHarness";

describe.skipIf(!PG_URL)("upload starts the ingest flow (needs DOCMIND_TEST_PG_URL)", () => {
  let h: DocumentHarness;
  beforeAll(async () => {
    h = await startDocumentServer();
  });
  afterAll(async () => {
    await h?.close();
  });

  const created = async (name: string, bytes: Buffer, user = "alice") => {
    const res = await h.upload(user, name, bytes);
    return { res, body: (await res.json()) as UploadDocumentResponse };
  };

  it("starts exactly one execution per new document, after the row is committed, with the owner's execution id", async () => {
    const { res, body } = await created("a.txt", TEXT("starts once"));
    expect(res.status).toBe(201);
    await h.starts.idle();
    const id = body.document.id;
    expect(h.ingest.calls.filter((c) => c === `start:${id}`)).toHaveLength(1);
    const handle = h.ingest.handles.get(id);
    expect(handle?.executionId).toBe(ingestExecutionId(U1, id));
    const state = await handle?.waitForCompletion();
    expect(state?.status).toBe("completed");
    expect(state?.variables._output).toEqual({ outcome: "accepted" });
    // The stub writes nothing: the document is still `uploaded`.
    const row = await h.owner.query("SELECT status FROM documents WHERE id = $1", [id]);
    expect(row.rows[0].status).toBe("uploaded");
  });

  it("re-attempts the start for a duplicate that is still uploaded, which creates no second execution", async () => {
    const bytes = TEXT("dup flow");
    const first = await created("a.txt", bytes);
    await h.starts.idle();
    const id = first.body.document.id;
    const handle = h.ingest.handles.get(id);
    await handle?.waitForCompletion();
    const again = await created("again.txt", bytes);
    expect(again.res.status).toBe(200);
    await h.starts.idle();
    // Two start calls, one execution (the stored handle is the first one, not replaced).
    expect(h.ingest.calls.filter((c) => c === `start:${id}`)).toHaveLength(2);
    expect(h.ingest.handles.get(id)).toBe(handle);
  });

  it("starts nothing for an upload that is refused", async () => {
    const before = h.ingest.calls.length;
    const res = await h.upload("alice", "tool.exe", Buffer.from("MZ\u0090\u0000\u0003"));
    expect(res.status).toBe(415);
    expect(h.ingest.calls.length).toBe(before);
  });

  it("answers 201 even when the start fails, logs only the class, and a later identical upload retries it", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    h.ingest.failNext("start");
    const bytes = TEXT("start fails");
    const first = await created("secret-name.txt", bytes);
    expect(first.res.status).toBe(201);
    expect(first.body.document.status).toBe("uploaded");
    await h.starts.idle();
    expect(h.ingest.handles.has(first.body.document.id)).toBe(false);
    const logged = JSON.stringify(spy.mock.calls);
    expect(logged).not.toContain("secret-name");
    expect(logged).not.toContain("synthetic-start-error"); // only the class is logged
    spy.mockRestore();

    const retry = await created("secret-name.txt", bytes);
    expect(retry.res.status).toBe(200);
    await h.starts.idle();
    expect(retry.body.duplicate).toBe(true);
    expect(h.ingest.handles.has(first.body.document.id)).toBe(true);
  });

  it("answers the upload while the flow start is still pending, then starts it", async () => {
    h.ingest.holdStart();
    const { res, body } = await created("slow.txt", TEXT("slow start"));
    expect(res.status).toBe(201);
    expect(h.ingest.handles.has(body.document.id)).toBe(false);
    h.ingest.releaseStart();
    await h.starts.idle();
    expect(h.ingest.handles.has(body.document.id)).toBe(true);
  });

  it("a delete waits for that document's pending start in this process, so the cancel lands on the started run", async () => {
    h.ingest.hold(); // the started step waits, so the cancel meets a live run
    h.ingest.holdStart();
    const { body } = await created("race.txt", TEXT("delete during start"));
    const id = body.document.id;
    let parked: () => void = () => {};
    const reached = new Promise<void>((resolve) => {
      parked = resolve;
    });
    const real = h.starts.settle.bind(h.starts);
    const spy = vi.spyOn(h.starts, "settle").mockImplementation((...args) => {
      parked();
      return real(...args);
    });
    try {
      const deleting = fetch(`${h.base}/api/documents/${id}`, {
        method: "DELETE",
        headers: { "x-test-user": "alice" },
      });
      await reached; // the delete is now waiting on the held start
      expect(h.ingest.calls.filter((c) => c.endsWith(id))).toEqual([]);
      h.ingest.releaseStart();
      expect((await deleting).status).toBe(204);
      expect(h.ingest.calls.filter((c) => c.endsWith(id))).toEqual([`start:${id}`, `cancel:${id}`]);
    } finally {
      spy.mockRestore();
      h.ingest.releaseStart();
      h.ingest.release();
    }
    const handle = h.ingest.handles.get(id);
    await expect(handle?.waitForCompletion()).rejects.toThrow(/cancel/i);
    expect(handle?.getState().status).toBe("cancelled");
  });

  it("gives the execution only ids: the stub's start input has no filename, title or content", async () => {
    const { body } = await created("Quarterly report.txt", TEXT("ids only"));
    const handle = h.ingest.handles.get(body.document.id);
    const state = JSON.stringify(handle?.getState());
    expect(state).not.toContain("Quarterly");
    expect(state).not.toContain("report");
    expect((body.document as DocumentDto).filename).toBe("Quarterly report.txt");
  });
});

describe.skipIf(!PG_URL)(
  "a delete does not wait forever for a pending start (needs DOCMIND_TEST_PG_URL)",
  () => {
    let h: DocumentHarness;
    beforeAll(async () => {
      h = await startDocumentServer({ deps: (d) => ({ ...d, settleTimeoutMs: 20 }) });
    });
    afterAll(async () => {
      await h?.close();
    });

    it("cancels anyway once the settle limit passes; the start that lands later is harmless", async () => {
      h.ingest.holdStart();
      const res = await h.upload("alice", "hung.txt", TEXT("hung start"));
      const id = ((await res.json()) as UploadDocumentResponse).document.id;
      try {
        const del = await fetch(`${h.base}/api/documents/${id}`, {
          method: "DELETE",
          headers: { "x-test-user": "alice" },
        });
        expect(del.status).toBe(204);
        expect(h.ingest.calls.filter((c) => c.endsWith(id))).toEqual([`cancel:${id}`]);
      } finally {
        h.ingest.releaseStart();
      }
      await h.starts.idle();
      const handle = h.ingest.handles.get(id);
      expect((await handle?.waitForCompletion())?.variables._output).toEqual({
        outcome: "document_gone",
      });
    });
  },
);
