import { randomUUID } from "node:crypto";
import { ParseAbortedError, type ParsedDocument } from "@docmind/parsers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PG_URL } from "../../db/testSupport";
import { T2, U1B } from "../../documents/testHarness";
import { chunkDocument, chunkIdFor } from "./chunker";
import { DocumentGoneError } from "./errors";
import { PgChunkStore, chunkBind } from "./pgChunks";
import { type PgFixture, startPgFixture } from "./pgFixture";

const sample = (n: number): ParsedDocument => {
  const text = Array.from(
    { length: n },
    (_, i) => `Paragraph ${i} ${"lorem ipsum ".repeat(60)}`,
  ).join("\n\n");
  return {
    text,
    sections: [
      {
        headingPath: ["Intro", "Part"],
        text,
        locator: { kind: "chars", start: 0, end: text.length },
      },
    ],
    media: [],
  };
};

describe.skipIf(!PG_URL)("PgChunkStore replace and count (needs DOCMIND_TEST_PG_URL)", () => {
  let f: PgFixture;
  beforeAll(async () => {
    f = await startPgFixture();
  });
  afterAll(async () => {
    await f?.close();
  });
  const fresh = () => f.doc(randomUUID().replaceAll("-", "").repeat(2));
  const rawRows = async (documentId: string) =>
    (
      await f.db.owner.query(
        "SELECT id, ordinal, text_enc, locator, token_count FROM chunks WHERE document_id = $1 ORDER BY ordinal",
        [documentId],
      )
    ).rows;

  it("a replace whose attempt was abandoned (aborted signal) rolls back: nothing is deleted or written", async () => {
    const ref = await fresh();
    const store = new PgChunkStore(f.app, f.fields);
    await store.replace(ref, chunkDocument(sample(2)));
    const before = await store.count(ref);
    await expect(
      store.replace(ref, chunkDocument(sample(6)), AbortSignal.abort()),
    ).rejects.toBeInstanceOf(ParseAbortedError);
    expect(await store.count(ref)).toBe(before);
  });

  it("stores sealed chunks under deterministic ids, with numeric locators and plaintext counts", async () => {
    const ref = await f.doc("7".repeat(64));
    const chunks = chunkDocument(sample(8));
    const store = new PgChunkStore(f.app, f.fields);
    expect(await store.replace(ref, chunks)).toBe(chunks.length);
    expect(await store.count(ref)).toBe(chunks.length);
    const rows = await rawRows(ref.documentId);
    expect(rows.map((r) => r.id)).toEqual(chunks.map((c) => chunkIdFor(ref.documentId, c.ordinal)));
    expect(rows[0].text_enc.__loomEnc).toBe("loom/aes-256-gcm");
    expect(rows[0].locator).toEqual(chunks[0]?.locator);
    expect(rows[0].token_count).toBe(chunks[0]?.tokenCount);
    const opened = await f.fields.forUser(ref.userId).open(chunkBind(rows[0].id), rows[0].text_enc);
    expect(opened).toEqual({ text: chunks[0]?.text, headingPath: ["Intro", "Part"] });
  });

  it("is idempotent, a shorter set removes the rest, and another document's rows are untouched", async () => {
    const other = await fresh();
    const ref = await f.doc("8".repeat(64));
    const store = new PgChunkStore(f.app, f.fields);
    const long = chunkDocument(sample(8));
    await store.replace(other, long);
    const otherRows = await rawRows(other.documentId);
    await store.replace(ref, long);
    await store.replace(ref, long);
    await store.replace(ref, long.slice(0, 1));
    expect((await rawRows(ref.documentId)).map((r) => r.ordinal)).toEqual([0]);
    await store.replace(ref, []);
    expect(await store.count(ref)).toBe(0);
    expect(await rawRows(other.documentId)).toEqual(otherRows);
  });

  it.each(["replace", "count"] as const)(
    "%s throws DocumentGoneError for another owner, another tenant, a missing and a deleted document",
    async (op) => {
      const ref = await fresh();
      const store = new PgChunkStore(f.app, f.fields);
      await store.replace(ref, chunkDocument(sample(3)));
      const call = (r: typeof ref) => (op === "replace" ? store.replace(r, []) : store.count(r));
      await expect(call({ ...ref, userId: U1B })).rejects.toBeInstanceOf(DocumentGoneError);
      await expect(call({ ...ref, tenantId: T2 })).rejects.toBeInstanceOf(DocumentGoneError);
      await expect(call({ ...ref, documentId: randomUUID() })).rejects.toBeInstanceOf(
        DocumentGoneError,
      );
      await f.db.owner.query("DELETE FROM documents WHERE id = $1", [ref.documentId]);
      await expect(call(ref)).rejects.toBeInstanceOf(DocumentGoneError);
      expect(await rawRows(ref.documentId)).toEqual([]); // cascaded away with the document
    },
  );

  it("a replace that meets an uncommitted delete waits for the lock, then reports DocumentGoneError", async () => {
    const ref = await fresh();
    const store = new PgChunkStore(f.app, f.fields);
    const deleter = await f.db.owner.connect();
    try {
      await deleter.query("BEGIN");
      await deleter.query("DELETE FROM documents WHERE id = $1", [ref.documentId]);
      const settled = store.replace(ref, chunkDocument(sample(3))).then(
        () => "resolved",
        (e: unknown) => e,
      );
      // Condition wait with a deadline: some backend in this database is blocked on a lock.
      const deadline = Date.now() + 5000;
      for (;;) {
        const { rowCount } = await f.db.owner.query(
          "SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()",
        );
        if (rowCount) break;
        if (Date.now() > deadline) throw new Error("replace never waited on the document lock");
        await new Promise((r) => setImmediate(r));
      }
      await deleter.query("COMMIT");
      expect(await settled).toBeInstanceOf(DocumentGoneError);
    } finally {
      await deleter.query("ROLLBACK").catch(() => undefined);
      deleter.release();
    }
  });
});
