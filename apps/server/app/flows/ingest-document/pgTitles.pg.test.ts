import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "../../db/tenant";
import { PG_URL } from "../../db/testSupport";
import { insertDocument } from "../../documents/repo";
import { T1, U1B, newDocument } from "../../documents/testHarness";
import { chunkDocument, chunkIdFor } from "./chunker";
import { DocumentGoneError } from "./errors";
import { PgChunkStore } from "./pgChunks";
import { type PgFixture, startPgFixture } from "./pgFixture";
import { PgTitleSource } from "./pgTitles";

describe.skipIf(!PG_URL)("PgTitleSource (needs DOCMIND_TEST_PG_URL)", () => {
  let f: PgFixture;
  beforeAll(async () => {
    f = await startPgFixture();
  });
  afterAll(async () => {
    await f?.close();
  });

  it("lists the owner's other documents with opened titles and ordinal-0 chunk ids, never the document itself or another owner's", async () => {
    const me = await f.doc("1".repeat(64));
    const other = await f.doc("2".repeat(64));
    const bare = await f.doc("3".repeat(64));
    const theirs = await newDocument(f.fields, T1, U1B, "4".repeat(64));
    await withTenant(f.app, T1, (tx) => insertDocument(tx, theirs));
    const chunks = new PgChunkStore(f.app, f.fields);
    const text = "Alpha paragraph. ".repeat(10);
    const parsed = {
      text,
      sections: [
        { headingPath: [], text, locator: { kind: "chars" as const, start: 0, end: text.length } },
      ],
      media: [],
    };
    await chunks.replace(other, chunkDocument(parsed));
    const found = await new PgTitleSource(f.app, f.fields).others(me);
    expect(found.map((t) => t.documentId).sort()).toEqual(
      [other.documentId, bare.documentId].sort(),
    );
    const o = found.find((t) => t.documentId === other.documentId);
    expect(o).toEqual({
      documentId: other.documentId,
      title: "Quarterly report",
      firstChunkId: chunkIdFor(other.documentId, 0),
    });
    expect(found.find((t) => t.documentId === bare.documentId)?.firstChunkId).toBeNull();
  });

  it("skips a title that does not open, and a document that is not the caller's is gone", async () => {
    const me = await f.doc("5".repeat(64));
    const broken = await f.doc("6".repeat(64));
    await f.db.owner.query(
      `UPDATE documents SET title_enc = '{"__loomEnc":"loom/aes-256-gcm","data":"AA==","iv":"AAAAAAAAAAAAAAAA","tag":"AAAAAAAAAAAAAAAAAAAAAA=="}'::jsonb WHERE id = $1`,
      [broken.documentId],
    );
    const src = new PgTitleSource(f.app, f.fields);
    expect((await src.others(me)).some((t) => t.documentId === broken.documentId)).toBe(false);
    await expect(src.others({ ...me, userId: U1B })).rejects.toBeInstanceOf(DocumentGoneError);
  });
});
