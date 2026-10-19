import { existsSync } from "node:fs";
import { join } from "node:path";
import type { DocumentDto } from "@docmind/contracts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PG_URL } from "../db/testSupport";
import { INGEST_GENERATION } from "./ingest";
import { ALICE, type DocumentHarness, T1, TEXT, U1, startDocumentServer } from "./testHarness";

/** Makes the next `ingest.start` wait, and says when it has been reached (i.e. after COMMIT). */
function startGate() {
  let reached: () => void = () => {};
  let open: () => void = () => {};
  const state = {
    armed: false,
    reached: new Promise<void>((r) => {
      reached = r;
    }),
    opened: new Promise<void>((r) => {
      open = r;
    }),
  };
  return { state, reached: () => reached(), open: () => open() };
}
const gate = startGate();

describe.skipIf(!PG_URL)("delete races and the erasure shape (needs DOCMIND_TEST_PG_URL)", () => {
  let h: DocumentHarness;
  beforeAll(async () => {
    h = await startDocumentServer({
      deps: (deps) => ({
        ...deps,
        ingest: {
          ...deps.ingest,
          start: async (identity, documentId, generation) => {
            if (gate.state.armed) {
              gate.state.armed = false;
              gate.reached();
              await gate.state.opened;
            }
            return deps.ingest.start(identity, documentId, generation);
          },
        },
      }),
    });
  });
  afterAll(async () => {
    gate.open(); // never leave a held start behind
    await h?.close();
  });

  const del = (id: string, user = "alice") =>
    fetch(`${h.base}/api/documents/${id}`, { method: "DELETE", headers: { "x-test-user": user } });
  const create = async (name: string, bytes: Buffer, user = "alice") =>
    ((await (await h.upload(user, name, bytes)).json()) as { document: DocumentDto }).document;
  const count = async (sql: string, args: unknown[]) =>
    (await h.owner.query(sql, args)).rows[0].n as number;
  const rows = (fp: string) =>
    count("SELECT count(*)::int AS n FROM documents WHERE fingerprint = $1", [fp]);
  const blob = (tenant: string, user: string, fp: string) => join(h.root, tenant, user, fp);

  /** The tenant write lock, taken the way the routes take it, held by a transaction of our own. */
  const holdTenantLock = async () => {
    const c = await h.owner.connect();
    await c.query("BEGIN");
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `docmind:documents:${T1}`,
    ]);
    return {
      release: async () => {
        await c.query("COMMIT");
        c.release();
      },
    };
  };
  /** Waits until `n` backends are queued on an advisory lock: a condition, not a delay. */
  /**
   * Waits until `n` backends of THIS database are queued on THIS tenant's lock (other suites share
   * the cluster and queue on advisory locks too). A condition with a deadline, not a delay.
   */
  const waitForWaiters = (n: number) =>
    expect
      .poll(
        () =>
          count(
            `SELECT count(*)::int AS n FROM pg_locks
              WHERE locktype = 'advisory' AND NOT granted AND objsubid = 1
                AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
                AND (classid::bigint << 32) | objid::bigint = hashtextextended($1, 0)`,
            [`docmind:documents:${T1}`],
          ),
        { timeout: 10_000 },
      )
      .toBe(n);

  it("delete first, then the same bytes: the upload makes a new row and a new blob", async () => {
    const bytes = TEXT("delete wins the lock");
    const doc = await create("r.txt", bytes);
    const fp = await h.fingerprint("alice", bytes);
    const held = await holdTenantLock();
    let deleted: Promise<Response>;
    let uploaded: Promise<Response>;
    try {
      deleted = del(doc.id);
      await waitForWaiters(1); // the delete is queued on the lock; locks are granted in queue order
      uploaded = h.upload("alice", "r2.txt", bytes);
      await waitForWaiters(2);
    } finally {
      await held.release();
    }
    expect((await deleted).status).toBe(204);
    const res = await uploaded;
    expect(res.status).toBe(201);
    const created = ((await res.json()) as { document: DocumentDto }).document;
    expect(created.id).not.toBe(doc.id);
    expect(await rows(fp)).toBe(1);
    expect(existsSync(blob(T1, U1, fp))).toBe(true);
  });

  it("the same bytes first, then the delete: the upload dedups onto the row, the delete removes row and blob", async () => {
    const bytes = TEXT("upload wins the lock");
    const doc = await create("r.txt", bytes);
    const fp = await h.fingerprint("alice", bytes);
    const held = await holdTenantLock();
    let deleted: Promise<Response>;
    let uploaded: Promise<Response>;
    try {
      uploaded = h.upload("alice", "r2.txt", bytes);
      await waitForWaiters(1);
      deleted = del(doc.id);
      await waitForWaiters(2);
    } finally {
      await held.release();
    }
    const res = await uploaded;
    expect(res.status).toBe(200);
    expect(((await res.json()) as { duplicate: boolean }).duplicate).toBe(true);
    expect((await deleted).status).toBe(204);
    expect(await rows(fp)).toBe(0);
    expect(existsSync(blob(T1, U1, fp))).toBe(false);
  });

  it("a delete between an upload's COMMIT and its start waits for the start (in this process), then cancels the run", async () => {
    h.ingest.hold(); // the started step waits, so the cancel meets a live run
    const bytes = TEXT("delete between commit and start");
    const fp = await h.fingerprint("alice", bytes);
    gate.state.armed = true;
    const uploaded = await h.upload("alice", "w.txt", bytes);
    let parked: () => void = () => {};
    const reached = new Promise<void>((resolve) => {
      parked = resolve;
    });
    const real = h.starts.settle.bind(h.starts);
    const spy = vi.spyOn(h.starts, "settle").mockImplementation((...args) => {
      parked();
      return real(...args);
    });
    let id = "";
    try {
      expect(uploaded.status).toBe(201); // answered although the start is held
      await gate.state.reached;
      id = ((await uploaded.json()) as { document: DocumentDto }).document.id;
      const callsBefore = h.ingest.calls.length;
      const deleting = del(id);
      await reached; // the delete is parked on the pending start
      expect(h.ingest.calls.slice(callsBefore)).toEqual([]);
      gate.open();
      expect((await deleting).status).toBe(204);
      expect(h.ingest.calls.slice(callsBefore)).toEqual([`start:${id}`, `cancel:${id}`]);
    } finally {
      spy.mockRestore();
      gate.open();
      h.ingest.release();
    }
    const handle = h.ingest.handles.get(id);
    await expect(handle?.waitForCompletion()).rejects.toThrow(/cancel/i);
    expect(handle?.getState().status).toBe("cancelled");
    expect(await rows(fp)).toBe(0);
    expect(existsSync(blob(T1, U1, fp))).toBe(false);
  });

  it("a start that lands after the delete (another process, or a duplicate after a failed start) ends document_gone", async () => {
    const bytes = TEXT("late start after delete");
    const fp = await h.fingerprint("alice", bytes);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    h.ingest.failNext("start"); // the first start fails, so no execution exists when the delete cancels
    const doc = await create("late.txt", bytes);
    await h.starts.idle();
    logged.mockRestore();
    expect((await del(doc.id)).status).toBe(204);
    expect(await rows(fp)).toBe(0);
    // Stand-in for a start the delete could not see (another process, or a duplicate upload).
    h.starts.fire(ALICE, doc.id, INGEST_GENERATION);
    await h.starts.idle();
    const handle = h.ingest.handles.get(doc.id);
    expect(handle).toBeDefined();
    const state = await handle?.waitForCompletion();
    expect(state?.variables._output).toEqual({ outcome: "document_gone" });
    expect(await rows(fp)).toBe(0);
    expect(existsSync(blob(T1, U1, fp))).toBe(false);
  });
});
