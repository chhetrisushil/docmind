import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "../../db/tenant";
import { PG_URL } from "../../db/testSupport";
import { insertDocument, titleBind } from "../../documents/repo";
import { T1, T2, U1, U1B, U2, newDocument } from "../../documents/testHarness";
import { type Chunk, chunkIdFor } from "../../flows/ingest-document/chunker";
import { PgChunkStore } from "../../flows/ingest-document/pgChunks";
import { type PgFixture, startPgFixture } from "../../flows/ingest-document/pgFixture";
import { PassageReader } from "./passages";

describe.skipIf(!PG_URL)("PassageReader (needs DOCMIND_TEST_PG_URL)", () => {
  let fx: PgFixture;
  let reader: PassageReader;
  const A = { tenantId: T1, ownerId: U1 };
  let msa: string; // U1's "Master Services Agreement": 14 chunks, sections of 7
  let notes: string; // U1's "Meeting notes": 2 chunks
  let theirs: string; // U1B's document, same tenant
  let bobs: string; // U2's document, another tenant

  const chunk = (ordinal: number, text: string, sectionOrdinal = 0): Chunk => ({
    ordinal,
    sectionOrdinal,
    headingPath: ["Terms", `Clause ${ordinal}`],
    text,
    tokenCount: Math.ceil(text.length / 4),
    locator: { kind: "section", index: sectionOrdinal },
  });
  async function seed(tenant: string, user: string, fp: string, title: string, chunks: Chunk[]) {
    const d = await newDocument(fx.fields, tenant, user, fp.repeat(64));
    await withTenant(fx.app, tenant, (tx) => insertDocument(tx, d));
    await fx.db.owner.query("UPDATE documents SET title_enc = $1::jsonb WHERE id = $2", [
      JSON.stringify(await fx.fields.forUser(user).seal(titleBind(d.id), title)),
      d.id,
    ]);
    await new PgChunkStore(fx.app, fx.fields).replace(
      { tenantId: tenant, userId: user, documentId: d.id },
      chunks,
    );
    return d.id;
  }
  const id = (doc: string, ordinal: number) => chunkIdFor(doc, ordinal);

  beforeAll(async () => {
    fx = await startPgFixture();
    reader = new PassageReader(fx.app, fx.fields);
    msa = await seed(
      T1,
      U1,
      "a",
      "Master Services Agreement",
      Array.from({ length: 14 }, (_, i) => chunk(i, `clause ${i} text`, Math.floor(i / 7))),
    );
    notes = await seed(T1, U1, "b", "Meeting notes", [
      chunk(0, "Agenda and attendees."),
      chunk(1, "Action items."),
    ]);
    theirs = await seed(T1, U1B, "c", "Alice2 private", [chunk(0, "not yours")]);
    bobs = await seed(T2, U2, "d", "Bob private", [chunk(0, "not yours either")]);
  });
  afterAll(async () => {
    await fx?.close();
  });

  describe("read", () => {
    it("returns passages from several documents with opened text, title, locator and heading path", async () => {
      const got = await reader.read(A, [id(msa, 3), id(notes, 1)]);
      expect([...got.keys()].sort()).toEqual([id(msa, 3), id(notes, 1)].sort());
      expect(got.get(id(msa, 3))).toEqual({
        passageId: id(msa, 3),
        documentId: msa,
        docTitle: "Master Services Agreement",
        locator: { kind: "section", index: 0 },
        headingPath: ["Terms", "Clause 3"],
        text: "clause 3 text",
      });
      expect(got.get(id(notes, 1))?.docTitle).toBe("Meeting notes");
      expect(got.get(id(notes, 1))).not.toHaveProperty("via");
    });

    it("leaves out unknown, malformed, another user's and another tenant's chunks, without an error", async () => {
      const got = await reader.read(A, [
        id(msa, 0),
        randomUUID(),
        "not-a-uuid",
        id(theirs, 0),
        id(bobs, 0),
      ]);
      expect([...got.keys()]).toEqual([id(msa, 0)]);
      expect((await reader.read({ tenantId: T2, ownerId: U2 }, [id(msa, 0)])).size).toBe(0);
      expect((await reader.read(A, [])).size).toBe(0);
    });

    it("accepts an upper-case id and refuses more than 100 ids", async () => {
      expect((await reader.read(A, [id(msa, 1).toUpperCase()])).has(id(msa, 1))).toBe(true);
      const many = Array.from({ length: 101 }, () => randomUUID());
      await expect(reader.read(A, many)).rejects.toThrow(/^read: at most 100 chunk ids$/);
      await expect(reader.read(A, many)).rejects.toBeInstanceOf(RangeError);
    });

    it("fails a stored chunk of the wrong shape with a fixed message, never the content", async () => {
      const bad = randomUUID();
      const sealed = await fx.fields
        .forUser(U1)
        .seal(`chunk:${bad}:text`, { secret: "do not leak this" });
      await fx.db.owner.query(
        `INSERT INTO chunks (id, tenant_id, document_id, ordinal, section_ordinal, text_enc, locator, token_count)
         VALUES ($1, $2, $3, 99, 9, $4::jsonb, '{"kind":"section","index":9}', 1)`,
        [bad, T1, notes, JSON.stringify(sealed)],
      );
      await expect(reader.read(A, [bad])).rejects.toThrow(
        /^the stored chunk has an invalid shape$/,
      );
      await fx.db.owner.query("DELETE FROM chunks WHERE id = $1", [bad]);
    });
  });

  describe("section", () => {
    const ords = (ps: { passageId: string }[], doc: string, n = 14) =>
      ps.map((p) => Array.from({ length: n }, (_, i) => i).find((i) => id(doc, i) === p.passageId));

    it("returns the passage's section, the passage first and the rest in reading order", async () => {
      const got = await reader.section(A, id(msa, 9), "section"); // section 1 = ordinals 7..13
      expect(ords(got, msa)).toEqual([9, 7, 8, 10, 11, 12, 13]);
      expect(got[0]?.docTitle).toBe("Master Services Agreement");
    });

    it("stops at 8 chunks, nearest first, and at 12,000 characters, always keeping the passage", async () => {
      const big = await seed(
        T1,
        U1,
        "e",
        "Long section",
        Array.from({ length: 20 }, (_, i) => chunk(i, `${i}`.padEnd(5000, "x"))),
      );
      const two = await reader.section(A, id(big, 10), "section");
      expect(two).toHaveLength(2); // 5000 + 5000 fits, a third would pass 12,000
      expect(ords(two, big, 20)).toEqual([10, 9]);
      const huge = await seed(T1, U1, "f", "One huge chunk", [
        chunk(0, "y".repeat(20_000)),
        chunk(1, "z"),
      ]);
      const cut = await reader.section(A, id(huge, 0), "section");
      expect(cut).toHaveLength(1);
      expect(cut[0]?.text).toHaveLength(12_000);
      const many = await seed(
        T1,
        U1,
        "1",
        "Many small",
        Array.from({ length: 30 }, (_, i) => chunk(i, `c${i}`)),
      );
      expect(await reader.section(A, id(many, 15), "section")).toHaveLength(8);
    });

    it("returns two chunks on each side for neighbours, and fewer at a document's edge", async () => {
      expect(ords(await reader.section(A, id(msa, 5), "neighbours"), msa)).toEqual([5, 3, 4, 6, 7]);
      expect(ords(await reader.section(A, id(msa, 0), "neighbours"), msa)).toEqual([0, 1, 2]);
      expect(ords(await reader.section(A, id(msa, 13), "neighbours"), msa)).toEqual([13, 11, 12]);
    });

    it("returns nothing for an unknown, malformed, another user's or another tenant's chunk", async () => {
      for (const span of ["section", "neighbours"] as const) {
        expect(await reader.section(A, randomUUID(), span)).toEqual([]);
        expect(await reader.section(A, "nope", span)).toEqual([]);
        expect(await reader.section(A, id(theirs, 0), span)).toEqual([]);
        expect(await reader.section(A, id(bobs, 0), span)).toEqual([]);
        expect(await reader.section({ tenantId: T2, ownerId: U2 }, id(msa, 5), span)).toEqual([]);
      }
    });
  });
});
