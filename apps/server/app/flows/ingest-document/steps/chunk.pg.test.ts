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
      put: (r, p, s) => real.put(r, p, s),
      take: async (r) => {
        const out = await real.take(r);
        taken();
        await gate;
        return out;
      },
      has: (r) => real.has(r),
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

  it("a re-run after the chunks were stored skips the work, keeps the parsed row, and does not re-chunk", async () => {
    const ref = await f.doc("d".repeat(64));
    const store = new PgParsedStore(f.app, f.fields);
    const real = new PgChunkStore(f.app, f.fields);
    let replaces = 0;
    const chunks: ChunkStore = {
      replace: (r, c, s) => {
        replaces++;
        return real.replace(r, c, s);
      },
      count: (r) => real.count(r),
      read: (r, ids) => real.read(r, ids),
    };
    await store.put(ref, parsed);
    const run = () =>
      chunkEffect({ guard: new PgStepGuard(f.app), parsed: store, chunks }).execute(
        ref,
        {} as never,
      );
    expect(await run()).toEqual({ outcome: "done", count: 1 });
    expect(await rows("parsed_documents", ref.documentId)).toBe(1); // kept for analyze and summarize
    expect(await run()).toEqual({ outcome: "done", count: 1 });
    expect(replaces).toBe(1);
    expect(await rows("chunks", ref.documentId)).toBe(1);
    expect(await rows("parsed_documents", ref.documentId)).toBe(1);
    const [{ id }] = (
      await f.db.owner.query("SELECT id FROM chunks WHERE document_id = $1", [ref.documentId])
    ).rows;
    expect((await real.read(ref, [id]))[0]?.text).toContain("Hello world.");
  });

  it("chunks that outlived a dropped parsed row are rebuilt after a fresh parse (put clears them)", async () => {
    const ref = await f.doc("e5".repeat(32));
    const store = new PgParsedStore(f.app, f.fields);
    const real = new PgChunkStore(f.app, f.fields);
    let replaces = 0;
    const chunks: ChunkStore = {
      replace: (r, c, s) => {
        replaces++;
        return real.replace(r, c, s);
      },
      count: (r) => real.count(r),
      read: (r, ids) => real.read(r, ids),
    };
    const run = () =>
      chunkEffect({ guard: new PgStepGuard(f.app), parsed: store, chunks }).execute(
        ref,
        {} as never,
      );
    await store.put(ref, parsed);
    await run();
    await store.drop(ref); // as finalize did, before the execution failed without its completion
    expect(await store.has(ref)).toBe(false);
    await store.put(ref, parsed); // parse runs again on the retry
    expect(await rows("chunks", ref.documentId)).toBe(0);
    expect(await run()).toEqual({ outcome: "done", count: 1 });
    expect(replaces).toBe(2);
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
