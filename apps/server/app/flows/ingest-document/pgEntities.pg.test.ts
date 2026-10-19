import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EntityKeys } from "../../crypto/entityKeys";
import { ENTITY_LOCK_SHARED } from "../../db/entityLock";
import { withTenant } from "../../db/tenant";
import { PG_URL } from "../../db/testSupport";
import { deleteDocument, insertDocument } from "../../documents/repo";
import { T1, T2, U1, U1B, U2, newDocument } from "../../documents/testHarness";
import { DocumentGoneError } from "./errors";
import type { IngestStartInput } from "./flow";
import { type EntityStore, PgEntityStore, entityNameBind } from "./pgEntities";
import { type PgFixture, startPgFixture } from "./pgFixture";

describe.skipIf(!PG_URL)("PgEntityStore (needs DOCMIND_TEST_PG_URL)", () => {
  let fx: PgFixture;
  let store: EntityStore;
  let DOC_A: IngestStartInput;
  let DOC_B: IngestStartInput;
  let ALICE2_DOC: IngestStartInput;
  let BOB_DOC: IngestStartInput;
  const chunks = new Map<string, string[]>();

  async function seedDoc(tenant: string, user: string, fp: string): Promise<IngestStartInput> {
    const d = await newDocument(fx.fields, tenant, user, fp);
    await withTenant(fx.app, tenant, (tx) => insertDocument(tx, d));
    const ids = [randomUUID(), randomUUID()];
    for (const [i, id] of ids.entries()) {
      await fx.db.owner.query(
        `INSERT INTO chunks (id, tenant_id, document_id, ordinal, section_ordinal, text_enc, locator, token_count)
         VALUES ($1, $2, $3, $4, 0, '{"x":1}', '{"kind":"chars","start":0,"end":5}', 2)`,
        [id, tenant, d.id, i],
      );
    }
    chunks.set(d.id, ids);
    return { tenantId: tenant, userId: user, documentId: d.id };
  }
  const ch = (d: IngestStartInput, i: number) => chunks.get(d.documentId)?.[i] as string;
  const count = async (sql: string, params: unknown[] = []) =>
    (await fx.db.owner.query<{ n: number }>(`SELECT count(*)::int AS n FROM (${sql}) q`, params))
      .rows[0]?.n;

  beforeAll(async () => {
    fx = await startPgFixture();
    store = new PgEntityStore(fx.app, fx.fields, new EntityKeys(fx.keys));
    DOC_A = await seedDoc(T1, U1, "a".repeat(64));
    DOC_B = await seedDoc(T1, U1, "b".repeat(64));
    ALICE2_DOC = await seedDoc(T1, U1B, "c".repeat(64));
    BOB_DOC = await seedDoc(T2, U2, "d".repeat(64));
  });
  afterAll(async () => {
    await fx?.close();
  });
  beforeEach(async () => {
    await fx.db.owner.query("DELETE FROM entities");
  });

  it("upserts entities by name key and links them to the document's chunks", async () => {
    const n = await store.replaceForDocument(DOC_A, [
      { chunkIds: [ch(DOC_A, 0), ch(DOC_A, 1)], name: "Acme Ltd", kind: "organization" },
      { chunkIds: [ch(DOC_A, 1)], name: "ACME", kind: "organization" },
      { chunkIds: [ch(DOC_A, 0)], name: "Jane Roe", kind: "person" },
      { chunkIds: [ch(DOC_A, 0)], name: "!!!", kind: "other" },
    ]);
    expect(n).toBe(3);
    expect(await count("SELECT 1 FROM entities")).toBe(2);
  });

  it("takes the first kind that is not 'other'", async () => {
    await store.replaceForDocument(DOC_A, [
      { chunkIds: [ch(DOC_A, 0)], name: "Atlas", kind: "other" },
      { chunkIds: [ch(DOC_A, 1)], name: "atlas", kind: "project" },
    ]);
    const { rows } = await fx.db.owner.query("SELECT kind FROM entities");
    expect(rows).toEqual([{ kind: "project" }]);
  });

  it("replaces the document's mentions on a re-run and ignores chunk ids that are not the document's", async () => {
    await store.replaceForDocument(DOC_A, [
      { chunkIds: [ch(DOC_A, 1)], name: "Old", kind: "other" },
    ]);
    await store.replaceForDocument(DOC_A, [
      {
        chunkIds: [ch(DOC_A, 0), ch(DOC_B, 0), ch(ALICE2_DOC, 0), "not-a-uuid"],
        name: "Acme",
        kind: "organization",
      },
    ]);
    const { rows } = await fx.db.owner.query<{ chunk_id: string }>(
      "SELECT chunk_id FROM chunk_entities",
    );
    expect(rows.map((r) => r.chunk_id)).toEqual([ch(DOC_A, 0)]);
  });

  it("finds the owner's other chunks that share an entity, rarest first, never another user's", async () => {
    await store.replaceForDocument(DOC_A, [
      { chunkIds: [ch(DOC_A, 0)], name: "Acme", kind: "organization" },
    ]);
    await store.replaceForDocument(DOC_B, [
      { chunkIds: [ch(DOC_B, 0)], name: "acme", kind: "organization" },
    ]);
    await store.replaceForDocument(ALICE2_DOC, [
      { chunkIds: [ch(ALICE2_DOC, 0)], name: "Acme", kind: "organization" },
    ]);
    await store.replaceForDocument(BOB_DOC, [
      { chunkIds: [ch(BOB_DOC, 0)], name: "Acme", kind: "organization" },
    ]);
    expect(await store.sharedWith(DOC_A)).toEqual([
      {
        chunkId: ch(DOC_A, 0),
        otherChunkId: ch(DOC_B, 0),
        entityId: expect.any(String),
        chunksWithEntity: 2,
      },
    ]);
    expect(await count("SELECT 1 FROM entities")).toBe(3);
  });

  it("orders shared rows rarest entity first", async () => {
    await store.replaceForDocument(DOC_A, [
      { chunkIds: [ch(DOC_A, 0)], name: "Common", kind: "other" },
      { chunkIds: [ch(DOC_A, 1)], name: "Rare", kind: "other" },
    ]);
    await store.replaceForDocument(DOC_B, [
      { chunkIds: [ch(DOC_B, 0), ch(DOC_B, 1)], name: "Common", kind: "other" },
      { chunkIds: [ch(DOC_B, 1)], name: "Rare", kind: "other" },
    ]);
    const rows = await store.sharedWith(DOC_A);
    expect(rows.map((r) => r.chunksWithEntity)).toEqual([2, 3, 3]);
    expect(rows[0]?.chunkId).toBe(ch(DOC_A, 1));
  });

  it("seals names: the raw column is an envelope and opens to the first spelling seen", async () => {
    await store.replaceForDocument(DOC_A, [
      { chunkIds: [ch(DOC_A, 0)], name: "Northwind Traders Ltd", kind: "organization" },
    ]);
    await store.replaceForDocument(DOC_B, [
      { chunkIds: [ch(DOC_B, 0)], name: "NORTHWIND TRADERS", kind: "organization" },
    ]);
    const { rows } = await fx.db.owner.query<{ id: string; name_enc: { __loomEnc?: string } }>(
      "SELECT id, name_enc FROM entities",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name_enc.__loomEnc).toBe("loom/aes-256-gcm");
    expect(JSON.stringify(rows[0]?.name_enc)).not.toContain("Northwind Traders");
    const opened = await fx.fields
      .forUser(U1)
      .openText(entityNameBind(rows[0]?.id as string), rows[0]?.name_enc);
    expect(opened).toBe("Northwind Traders Ltd");
  });

  it("rolls back when the attempt was aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(
      store.replaceForDocument(
        DOC_A,
        [{ chunkIds: [ch(DOC_A, 0)], name: "Acme", kind: "organization" }],
        ac.signal,
      ),
    ).rejects.toMatchObject({ name: "ParseAbortedError" });
    expect(await count("SELECT 1 FROM entities")).toBe(0);
  });

  it("treats another user's document as gone", async () => {
    await expect(
      store.replaceForDocument({ ...ALICE2_DOC, userId: U1 }, [
        { chunkIds: [], name: "Acme", kind: "other" },
      ]),
    ).rejects.toBeInstanceOf(DocumentGoneError);
    await expect(store.sharedWith({ ...ALICE2_DOC, userId: U1 })).rejects.toBeInstanceOf(
      DocumentGoneError,
    );
  });

  it("a document delete purges the owner's entities no chunk mentions any more", async () => {
    await store.replaceForDocument(DOC_A, [
      { chunkIds: [ch(DOC_A, 0)], name: "Only In A", kind: "other" },
      { chunkIds: [ch(DOC_A, 1)], name: "Shared", kind: "other" },
    ]);
    await store.replaceForDocument(DOC_B, [
      { chunkIds: [ch(DOC_B, 0)], name: "Shared", kind: "other" },
    ]);
    await withTenant(fx.app, T1, (tx) => deleteDocument(tx, U1, DOC_A.documentId));
    const { rows } = await fx.db.owner.query("SELECT 1 FROM entities WHERE owner_id = $1", [U1]);
    expect(rows).toHaveLength(1);
  });

  it("a delete's purge waits for an in-flight ingest and does not cascade away its mention", async () => {
    const X = await seedDoc(T1, U1, "e".repeat(64));
    const Y = await seedDoc(T1, U1, "f".repeat(64));
    await store.replaceForDocument(X, [{ chunkIds: [ch(X, 0)], name: "Shared", kind: "other" }]);
    const entityId = (await fx.db.owner.query<{ id: string }>("SELECT id FROM entities")).rows[0]
      ?.id as string;
    // Ingest of B, held open after its mention insert (the same steps as replaceForDocument).
    const held = await fx.db.owner.connect();
    let deleting: Promise<unknown> | undefined;
    try {
      await held.query("BEGIN");
      await held.query(ENTITY_LOCK_SHARED, [U1]);
      await held.query(
        "INSERT INTO chunk_entities (tenant_id, chunk_id, entity_id) VALUES ($1, $2, $3)",
        [T1, ch(Y, 0), entityId],
      );
      deleting = withTenant(fx.app, T1, (tx) => deleteDocument(tx, U1, X.documentId));
      deleting.catch(() => {});
      await vi.waitFor(async () => {
        const { rowCount } = await fx.db.owner.query(
          "SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND wait_event = 'advisory'",
        );
        expect(rowCount).toBe(1);
      });
      await held.query("COMMIT");
    } finally {
      held.release();
    }
    await deleting;
    const { rows } = await fx.db.owner.query<{ chunk_id: string }>(
      "SELECT chunk_id FROM chunk_entities WHERE entity_id = $1",
      [entityId],
    );
    expect(rows.map((r) => r.chunk_id)).toEqual([ch(Y, 0)]);
    expect(await count("SELECT 1 FROM entities")).toBe(1);
  });
});
