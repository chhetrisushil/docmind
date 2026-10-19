import { randomUUID } from "node:crypto";
import type { ParsedDocument } from "@docmind/parsers";
import { Pool } from "pg";
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
      { headingPath: ["Intro"], text, locator: { kind: "chars", start: 0, end: text.length } },
    ],
    media: [],
  };
};

describe.skipIf(!PG_URL)("PgChunkStore read (needs DOCMIND_TEST_PG_URL)", () => {
  let f: PgFixture;
  beforeAll(async () => {
    f = await startPgFixture();
  });
  afterAll(async () => {
    await f?.close();
  });
  const fresh = () => f.doc(randomUUID().replaceAll("-", "").repeat(2));
  const rawIds = async (documentId: string) =>
    (
      await f.db.owner.query(
        "SELECT id, text_enc FROM chunks WHERE document_id = $1 ORDER BY ordinal",
        [documentId],
      )
    ).rows;

  it("reads opened texts for the ids asked, ignoring ids that do not exist or are malformed", async () => {
    const ref = await fresh();
    const store = new PgChunkStore(f.app, f.fields);
    const chunks = chunkDocument(sample(8));
    await store.replace(ref, chunks);
    const ids = [
      chunkIdFor(ref.documentId, 2),
      chunkIdFor(ref.documentId, 0),
      randomUUID(),
      "not-a-uuid",
    ];
    const got = await store.read(ref, ids);
    expect(got.map((g) => g.id)).toEqual([
      chunkIdFor(ref.documentId, 0),
      chunkIdFor(ref.documentId, 2),
    ]);
    expect(got.map((g) => g.text)).toEqual([chunks[0]?.text, chunks[2]?.text]);
    expect(await store.read(ref, [])).toEqual([]);
  });

  it("returns ordinal order whatever the heap order, and nothing for another document's ids", async () => {
    const ref = await fresh();
    const other = await fresh();
    const store = new PgChunkStore(f.app, f.fields);
    const chunks = chunkDocument(sample(8));
    await store.replace(ref, chunks);
    await store.replace(other, chunks);
    // An UPDATE moves a row to the end of the heap: ordinals 0 and 1 now sit after the rest.
    await f.db.owner.query(
      "UPDATE chunks SET token_count = token_count WHERE document_id = $1 AND ordinal < 2",
      [ref.documentId],
    );
    const ids = chunks.map((c) => chunkIdFor(ref.documentId, c.ordinal));
    // No index scans, so without ORDER BY the rows would come back in heap order.
    const scan = new Pool({
      connectionString: f.db.appUrl,
      options: "-c enable_indexscan=off -c enable_bitmapscan=off",
    });
    try {
      const got = await new PgChunkStore(scan, f.fields).read(ref, ids);
      expect(got.map((g) => g.id)).toEqual(ids);
    } finally {
      await scan.end();
    }
    const foreign = chunks.map((c) => chunkIdFor(other.documentId, c.ordinal));
    expect(await store.read(ref, foreign)).toEqual([]);
    expect(await store.read(ref, [...foreign, ids[3] as string])).toHaveLength(1);
  });

  it("is scoped to its owner and tenant, and is gone for a missing or deleted document", async () => {
    const ref = await fresh();
    const store = new PgChunkStore(f.app, f.fields);
    await store.replace(ref, chunkDocument(sample(3)));
    const call = (r: typeof ref) => store.read(r, [chunkIdFor(ref.documentId, 0)]);
    await expect(call({ ...ref, userId: U1B })).rejects.toBeInstanceOf(DocumentGoneError);
    await expect(call({ ...ref, tenantId: T2 })).rejects.toBeInstanceOf(DocumentGoneError);
    await expect(call({ ...ref, documentId: randomUUID() })).rejects.toBeInstanceOf(
      DocumentGoneError,
    );
    await f.db.owner.query("DELETE FROM documents WHERE id = $1", [ref.documentId]);
    await expect(call(ref)).rejects.toBeInstanceOf(DocumentGoneError);
  });

  it("rejects an envelope copied from another chunk (the AEAD binds it to its chunk id)", async () => {
    const ref = await fresh();
    const store = new PgChunkStore(f.app, f.fields);
    await store.replace(ref, chunkDocument(sample(8)));
    const [a, b] = await rawIds(ref.documentId);
    await f.db.owner.query("UPDATE chunks SET text_enc = $1 WHERE id = $2", [a.text_enc, b.id]);
    await expect(store.read(ref, [b.id])).rejects.toThrow(/unable to authenticate data/);
    await expect(store.read(ref, [a.id])).resolves.toHaveLength(1);
  });

  it("a malformed opened payload throws a fixed message with no cause and none of the content", async () => {
    const ref = await fresh();
    const store = new PgChunkStore(f.app, f.fields);
    await store.replace(ref, chunkDocument(sample(3)));
    const [row] = await rawIds(ref.documentId);
    const secret = "a distinctive secret payload";
    const bad = await f.fields
      .forUser(ref.userId)
      .seal(chunkBind(row.id), { text: 42, note: secret });
    await f.db.owner.query("UPDATE chunks SET text_enc = $1 WHERE id = $2", [bad, row.id]);
    const err = await store.read(ref, [row.id]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("the stored chunk has an invalid shape");
    expect((err as Error).cause).toBeUndefined();
    expect(JSON.stringify(err)).not.toContain(secret);
  });
});
