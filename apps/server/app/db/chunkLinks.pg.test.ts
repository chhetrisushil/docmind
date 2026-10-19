import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { T1, T2, U1, seedUsers } from "../documents/testHarness";
import { migrate, setAppRolePassword } from "./migrate";
import { withTenant } from "./tenant";
import { APP_PASSWORD, PG_URL, type TestDb, createTestDb } from "./testSupport";

const DOC = "d0d0d0d0-d0d0-4d0d-8d0d-d0d0d0d0d0d0";
const DOC2 = "d1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1";
const hex = (c: string) => c.repeat(64);

describe.skipIf(!PG_URL)("chunk_links (needs DOCMIND_TEST_PG_URL)", () => {
  let db: TestDb;
  let app: Pool;
  const A = randomUUID();
  const B = randomUUID();
  const C = randomUUID();
  const link = (tenant: string, src: string, dst: string, weight: number, kind = "similar") =>
    withTenant(app, tenant, (tx) =>
      tx.query(
        "INSERT INTO chunk_links (tenant_id, src_chunk_id, dst_chunk_id, kind, weight) VALUES ($1, $2, $3, $4, $5)",
        [tenant, src, dst, kind, weight],
      ),
    );
  const total = async () =>
    (await db.owner.query<{ n: number }>("SELECT count(*)::int AS n FROM chunk_links")).rows[0]?.n;

  beforeAll(async () => {
    db = await createTestDb();
    await migrate(db.owner);
    await setAppRolePassword(db.owner, APP_PASSWORD);
    await seedUsers(db.owner);
    for (const [doc, fp] of [
      [DOC, "a"],
      [DOC2, "b"],
    ] as const) {
      await db.owner.query(
        `INSERT INTO documents (id, tenant_id, owner_id, title_enc, filename_enc, mime, size_bytes, content_address, fingerprint)
         VALUES ($1, $2, $3, '{"x":1}', '{"x":2}', 'text/plain', 5, $4, $5)`,
        [doc, T1, U1, `hmac-sha256:${hex(fp)}`, hex(fp)],
      );
    }
    for (const [id, doc, ord] of [
      [A, DOC, 0],
      [B, DOC, 1],
      [C, DOC2, 0],
    ] as const) {
      await db.owner.query(
        `INSERT INTO chunks (id, tenant_id, document_id, ordinal, section_ordinal, text_enc, locator, token_count)
         VALUES ($1, $2, $3, $4, 0, '{"x":1}', '{"kind":"chars","start":0,"end":5}', 2)`,
        [id, T1, doc, ord],
      );
    }
    app = new Pool({ connectionString: db.appUrl });
  });
  afterAll(async () => {
    await app?.end();
    await db?.drop();
  });

  it("stores a link visible only inside its tenant", async () => {
    await link(T1, A, B, 0.5);
    const count = (t: string) =>
      withTenant(app, t, (tx) => tx.query("SELECT count(*)::int AS n FROM chunk_links"));
    expect((await count(T1)).rows[0].n).toBe(1);
    expect((await count(T2)).rows[0].n).toBe(0);
  });

  it("refuses writes for another tenant", async () => {
    await expect(
      withTenant(app, T2, (tx) =>
        tx.query(
          "INSERT INTO chunk_links (tenant_id, src_chunk_id, dst_chunk_id, kind, weight) VALUES ($1, $2, $3, 'similar', 0.5)",
          [T1, A, C],
        ),
      ),
    ).rejects.toMatchObject({
      code: "42501",
      message: /row-level security policy for table "chunk_links"/,
    });
  });

  it("refuses a self link, a weight of 0 and a weight of 1.5 by constraint name", async () => {
    await expect(link(T1, A, A, 0.5)).rejects.toMatchObject({
      code: "23514",
      constraint: "chunk_links_not_self",
    });
    await expect(link(T1, A, C, 0)).rejects.toMatchObject({
      code: "23514",
      constraint: "chunk_links_weight_check",
    });
    await expect(link(T1, A, C, 1.5)).rejects.toMatchObject({
      code: "23514",
      constraint: "chunk_links_weight_check",
    });
    await expect(link(T1, A, C, 0.5, "robot")).rejects.toMatchObject({
      code: "23514",
      constraint: "chunk_links_kind_check",
    });
  });

  it("refuses a duplicate and a chunk that does not exist, by constraint name", async () => {
    await expect(link(T1, A, B, 0.9)).rejects.toMatchObject({
      code: "23505",
      constraint: "chunk_links_pkey",
    });
    await expect(link(T1, A, randomUUID(), 0.5)).rejects.toMatchObject({
      code: "23503",
      constraint: "chunk_links_dst_fkey",
    });
    await expect(link(T1, randomUUID(), A, 0.5)).rejects.toMatchObject({
      code: "23503",
      constraint: "chunk_links_src_fkey",
    });
  });

  it("deleting a document removes links on both ends", async () => {
    await link(T1, B, C, 0.4);
    await link(T1, C, B, 0.4);
    expect(await total()).toBe(3);
    await db.owner.query("DELETE FROM documents WHERE id = $1", [DOC2]);
    // A-B survives (both in DOC); B-C and C-B are gone with C.
    expect(await total()).toBe(1);
    await db.owner.query("DELETE FROM documents WHERE id = $1", [DOC]);
    expect(await total()).toBe(0);
  });
});
