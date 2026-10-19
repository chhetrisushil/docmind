import { ParseAbortedError } from "@docmind/parsers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type ChunkStore, PgChunkStore } from "../pgChunks";
import { type PgFixture, startPgFixture } from "../pgFixture";
import { PgStepGuard } from "../pgGuard";
import { type ParsedStore, PgParsedStore } from "../pgParsed";
import { chunkEffect } from "./chunk";

const PG_URL = process.env.DOCMIND_TEST_PG_URL;
const parsed = {
  text: "Hello world.",
  sections: [
    {
      headingPath: ["H"],
      text: "Hello world.",
      locator: { kind: "chars" as const, start: 0, end: 12 },
    },
  ],
  media: [],
};

describe.skipIf(!PG_URL)("the chunk step over Postgres (needs DOCMIND_TEST_PG_URL)", () => {
  let f: PgFixture;
  beforeAll(async () => {
    f = await startPgFixture();
  });
  afterAll(async () => {
    await f?.close();
  });
  const rows = async (table: string, id: string) =>
    (await f.db.owner.query(`SELECT 1 FROM ${table} WHERE document_id = $1`, [id])).rowCount;

  it("a document deleted between reading the parsed text and storing the chunks stops the step as document_gone", async () => {
    const ref = await f.doc("c".repeat(64));
    const real = new PgParsedStore(f.app, f.fields);
    await real.put(ref, parsed);
    let open: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    let taken: () => void = () => {};
    const tookIt = new Promise<void>((resolve) => {
      taken = resolve;
    });
    const gated: ParsedStore = {
      put: (r, p) => real.put(r, p),
      take: async (r) => {
        const out = await real.take(r);
        taken();
        await gate;
        return out;
      },
      drop: (r) => real.drop(r),
    };
    const pending = chunkEffect({
      guard: new PgStepGuard(f.app),
      parsed: gated,
      chunks: new PgChunkStore(f.app, f.fields),
    }).execute(ref, {} as never);
    await tookIt;
    await f.db.owner.query("DELETE FROM documents WHERE id = $1", [ref.documentId]);
    open();
    expect(await pending).toEqual({ outcome: "document_gone" });
    expect(await rows("chunks", ref.documentId)).toBe(0);
  });

  it("crash window 1 (chunks stored, parsed not dropped): a re-run replaces the chunks and drops parsed", async () => {
    const ref = await f.doc("d".repeat(64));
    const store = new PgParsedStore(f.app, f.fields);
    const chunks = new PgChunkStore(f.app, f.fields);
    await store.put(ref, parsed);
    let crash = true;
    const crashing: ParsedStore = {
      put: (r, p) => store.put(r, p),
      take: (r) => store.take(r),
      drop: async (r) => {
        if (crash) throw new Error("process died");
        return store.drop(r);
      },
    };
    const effect = (p: ParsedStore) =>
      chunkEffect({
        guard: new PgStepGuard(f.app),
        parsed: p,
        chunks,
        sleep: async () => {},
        stepTimeoutMs: 5_000,
      });
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(effect(crashing).execute(ref, {} as never)).rejects.toThrow(
      /^ingest step failed: chunk$/,
    );
    quiet.mockRestore();
    expect(await rows("chunks", ref.documentId)).toBe(1);
    expect(await rows("parsed_documents", ref.documentId)).toBe(1);
    crash = false;
    expect(await effect(store).execute(ref, {} as never)).toEqual({ outcome: "done", count: 1 });
    expect(await rows("chunks", ref.documentId)).toBe(1);
    expect(await rows("parsed_documents", ref.documentId)).toBe(0);
    const [{ id }] = (
      await f.db.owner.query("SELECT id FROM chunks WHERE document_id = $1", [ref.documentId])
    ).rows;
    expect((await chunks.read(ref, [id]))[0]?.text).toContain("Hello world.");
  });

  it("crash window 2 (parsed dropped, event not appended): a re-run does not fail and reports the stored chunks", async () => {
    const ref = await f.doc("e".repeat(64));
    const store = new PgParsedStore(f.app, f.fields);
    const run = () =>
      chunkEffect({
        guard: new PgStepGuard(f.app),
        parsed: store,
        chunks: new PgChunkStore(f.app, f.fields),
      }).execute(ref, {} as never);
    await store.put(ref, parsed);
    expect(await run()).toEqual({ outcome: "done", count: 1 });
    expect(await rows("parsed_documents", ref.documentId)).toBe(0);
    expect(await run()).toEqual({ outcome: "done", count: 1 });
    expect(await rows("chunks", ref.documentId)).toBe(1);
  });

  it("an attempt that hangs past its bound never commits, and the next attempt waits for it to settle", async () => {
    const ref = await f.doc("f".repeat(64));
    const store = new PgParsedStore(f.app, f.fields);
    const real = new PgChunkStore(f.app, f.fields);
    await store.put(ref, parsed);
    let open: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    let first: AbortSignal | undefined;
    let begun = 0;
    let rowsAfterFirst = -1;
    let firstOutcome: unknown;
    let calls = 0;
    const chunks: ChunkStore = {
      ...real,
      count: (r) => real.count(r),
      read: (r, ids) => real.read(r, ids),
      replace: async (r, c, signal) => {
        if (++calls > 1) return real.replace(r, c, signal);
        first = signal;
        await gate; // past the bound by now
        try {
          return await real.replace(r, c, signal);
        } catch (err) {
          firstOutcome = err;
          throw err;
        } finally {
          rowsAfterFirst = (await rows("chunks", ref.documentId)) ?? -1;
        }
      },
    };
    const guard = { begin: async () => void begun++ };
    vi.spyOn(console, "error").mockImplementation(() => {});
    const pending = chunkEffect({
      guard,
      parsed: store,
      chunks,
      sleep: async () => {},
      stepTimeoutMs: 50,
      attemptSettleMs: 60_000,
    }).execute(ref, {} as never);
    await vi.waitFor(() => expect(first?.aborted).toBe(true));
    expect(begun).toBe(1); // attempt 2 has not started: attempt 1 is still alive
    open();
    expect(await pending).toEqual({ outcome: "done", count: 1 });
    expect(firstOutcome).toBeInstanceOf(ParseAbortedError);
    expect(rowsAfterFirst).toBe(0); // the abandoned attempt rolled back
    expect(begun).toBe(2);
    expect(await rows("chunks", ref.documentId)).toBe(1);
  });
});
