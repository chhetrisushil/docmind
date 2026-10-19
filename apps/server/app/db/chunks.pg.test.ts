import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { T1, T2, U1, seedUsers } from "../documents/testHarness";
import { migrate, setAppRolePassword } from "./migrate";
import { withTenant } from "./tenant";
import { APP_PASSWORD, PG_URL, type TestDb, createTestDb } from "./testSupport";

const DOC = "d0d0d0d0-d0d0-4d0d-8d0d-d0d0d0d0d0d0";
const CHUNK = (n: number) => `c${n}c0c0c0-c0c0-4c0c-8c0c-c0c0c0c0c0c0`;
const insertChunk = (
  tx: { query: Pool["query"] },
  id: string,
  tenant: string,
  doc: string,
  ordinal = 0,
) =>
  tx.query(
    `INSERT INTO chunks (id, tenant_id, document_id, ordinal, section_ordinal, text_enc, locator, token_count)
     VALUES ($1, $2, $3, $4, 0, '{"x":1}', '{"kind":"chars","start":0,"end":5}', 2)`,
    [id, tenant, doc, ordinal],
  );

describe.skipIf(!PG_URL)("chunks and parsed_documents (needs DOCMIND_TEST_PG_URL)", () => {
  let db: TestDb;
  let app: Pool;
  beforeAll(async () => {
    db = await createTestDb();
    await migrate(db.owner);
    await setAppRolePassword(db.owner, APP_PASSWORD);
    await seedUsers(db.owner);
    await db.owner.query(
      `INSERT INTO documents (id, tenant_id, owner_id, title_enc, filename_enc, mime, size_bytes, content_address, fingerprint)
       VALUES ($1, $2, $3, '{"x":1}', '{"x":2}', 'text/plain', 5, $4, $5)`,
      [DOC, T1, U1, `hmac-sha256:${"a".repeat(64)}`, "a".repeat(64)],
    );
    app = new Pool({ connectionString: db.appUrl });
  });
  afterAll(async () => {
    await app?.end();
    await db?.drop();
  });

  it("stores a chunk and a parsed body under their document, in their tenant", async () => {
    await withTenant(app, T1, async (tx) => {
      await insertChunk(tx, CHUNK(1), T1, DOC);
      await tx.query(
        "INSERT INTO parsed_documents (tenant_id, document_id, body_enc) VALUES ($1, $2, '{\"x\":1}')",
        [T1, DOC],
      );
    });
    const { rows } = await withTenant(app, T1, (tx) =>
      tx.query("SELECT count(*)::int AS n FROM chunks"),
    );
    expect(rows[0].n).toBe(1);
  });

  it("refuses a chunk that pairs a document with another tenant (composite foreign key)", async () => {
    await expect(
      withTenant(app, T2, (tx) => insertChunk(tx, CHUNK(2), T2, DOC)),
    ).rejects.toMatchObject({
      code: "23503",
      constraint: "chunks_document_fkey",
    });
  });

  it("refuses a second chunk with the same ordinal in a document", async () => {
    await expect(
      withTenant(app, T1, (tx) => insertChunk(tx, CHUNK(3), T1, DOC, 0)),
    ).rejects.toMatchObject({
      code: "23505",
      constraint: "chunks_document_ordinal_key",
    });
  });

  it("hides another tenant's rows and refuses to write them", async () => {
    const seen = await withTenant(app, T2, (tx) =>
      tx.query("SELECT 1 FROM chunks UNION ALL SELECT 1 FROM parsed_documents"),
    );
    expect(seen.rowCount).toBe(0);
    await expect(
      withTenant(app, T2, (tx) => insertChunk(tx, CHUNK(4), T1, DOC, 9)),
    ).rejects.toMatchObject({
      code: "42501",
    });
  });

  it("deletes chunks and the parsed body with their document", async () => {
    await db.owner.query("DELETE FROM documents WHERE id = $1", [DOC]);
    const { rows } = await db.owner.query(
      "SELECT (SELECT count(*) FROM chunks)::int AS c, (SELECT count(*) FROM parsed_documents)::int AS p",
    );
    expect(rows[0]).toEqual({ c: 0, p: 0 });
  });
});
