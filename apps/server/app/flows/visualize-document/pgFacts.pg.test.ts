import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "../../db/tenant";
import { PG_URL } from "../../db/testSupport";
import { deleteDocument } from "../../documents/repo";
import { T1, T2, U1B } from "../../documents/testHarness";
import { DocumentGoneError } from "../ingest-document/errors";
import { type PgFixture, startPgFixture } from "../ingest-document/pgFixture";
import type { Fact } from "./facts";
import { PgVisualFacts, type VisualizeRef } from "./pgFacts";

describe.skipIf(!PG_URL)("PgVisualFacts (needs DOCMIND_TEST_PG_URL)", () => {
  let fx: PgFixture;
  beforeAll(async () => {
    fx = await startPgFixture();
  });
  afterAll(async () => {
    await fx?.close();
  });

  const fig = (ordinal: number, chunk: string): Fact => ({
    kind: "figure",
    label: "Revenue",
    value: 1200,
    chunkIds: [chunk],
    ordinal,
  });
  async function seedChunk(ref: VisualizeRef): Promise<string> {
    const id = randomUUID();
    await fx.db.owner.query(
      `INSERT INTO chunks (id, tenant_id, document_id, ordinal, section_ordinal, text_enc, locator, token_count)
       VALUES ($1, $2, $3, 0, 0, '{"x":1}', '{"kind":"chars","start":0,"end":5}', 2)`,
      [id, ref.tenantId, ref.documentId],
    );
    return id;
  }
  const rowCount = async (documentId: string) =>
    (
      await fx.db.owner.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM visual_facts WHERE document_id = $1",
        [documentId],
      )
    ).rows[0]?.n;

  it("round-trips sealed facts in ordinal order and replaces in one transaction", async () => {
    const ref = await fx.doc("1".repeat(64));
    const chunk = await seedChunk(ref);
    const store = new PgVisualFacts(fx.app, fx.fields);
    expect(await store.replace(ref, [fig(1, chunk), fig(0, chunk)])).toBe(2);
    expect((await store.list(ref)).map((f) => f.ordinal)).toEqual([0, 1]);
    await store.replace(ref, [fig(0, chunk)]);
    expect(await store.list(ref)).toEqual([fig(0, chunk)]);
  });

  it("stores no plaintext label", async () => {
    const ref = await fx.doc("2".repeat(64));
    const chunk = await seedChunk(ref);
    await new PgVisualFacts(fx.app, fx.fields).replace(ref, [fig(0, chunk)]);
    const raw = await fx.db.owner.query(
      "SELECT fact_enc::text AS t FROM visual_facts WHERE document_id = $1",
      [ref.documentId],
    );
    expect(raw.rows).toHaveLength(1);
    expect(raw.rows.map((r) => r.t).join()).not.toContain("Revenue");
  });

  it("is invisible to another tenant and gone with the document", async () => {
    const ref = await fx.doc("3".repeat(64));
    const chunk = await seedChunk(ref);
    await new PgVisualFacts(fx.app, fx.fields).replace(ref, [fig(0, chunk)]);
    const other = await withTenant(fx.app, T2, (tx) =>
      tx.query("SELECT 1 FROM visual_facts WHERE document_id = $1", [ref.documentId]),
    );
    expect(other.rows).toEqual([]);
    const own = await withTenant(fx.app, T1, (tx) =>
      tx.query("SELECT 1 FROM visual_facts WHERE document_id = $1", [ref.documentId]),
    );
    expect(own.rows).toHaveLength(1);
    expect(await rowCount(ref.documentId)).toBe(1);
    await withTenant(fx.app, T1, (tx) => deleteDocument(tx, ref.userId, ref.documentId));
    expect(await rowCount(ref.documentId)).toBe(0);
  });

  it("rolls back a replace whose attempt was aborted", async () => {
    const ref = await fx.doc("4".repeat(64));
    const chunk = await seedChunk(ref);
    const store = new PgVisualFacts(fx.app, fx.fields);
    await store.replace(ref, [fig(0, chunk)]);
    const ac = new AbortController();
    ac.abort();
    await expect(
      store.replace(ref, [fig(0, chunk), fig(1, chunk)], ac.signal),
    ).rejects.toMatchObject({
      name: "ParseAbortedError",
    });
    expect(await rowCount(ref.documentId)).toBe(1);
  });

  it("list and replace throw DocumentGoneError for a document the user does not own", async () => {
    const ref = await fx.doc("5".repeat(64));
    const chunk = await seedChunk(ref);
    const store = new PgVisualFacts(fx.app, fx.fields);
    const stranger = { ...ref, userId: U1B };
    await expect(store.list(stranger)).rejects.toBeInstanceOf(DocumentGoneError);
    await expect(store.replace(stranger, [fig(0, chunk)])).rejects.toBeInstanceOf(
      DocumentGoneError,
    );
    expect(await rowCount(ref.documentId)).toBe(0);
  });
});
