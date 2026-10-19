import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { T1, T2, U1, U1B, seedUsers } from "../documents/testHarness";
import { migrate, setAppRolePassword } from "./migrate";
import { withTenant } from "./tenant";
import { APP_PASSWORD, PG_URL, type TestDb, createTestDb } from "./testSupport";

const DOC = "d0d0d0d0-d0d0-4d0d-8d0d-d0d0d0d0d0d0";
const CHUNK = "c1c0c0c0-c0c0-4c0c-8c0c-c0c0c0c0c0c0";
const hex = (c: string) => c.repeat(64);

const insertEntity = (
  tx: Pool | { query: Pool["query"] },
  id: string,
  tenant: string,
  owner: string,
  nameKey: string,
  kind = "organization",
) =>
  tx.query(
    `INSERT INTO entities (id, tenant_id, owner_id, kind, name_enc, name_key)
     VALUES ($1, $2, $3, $4, '{"x":1}', $5)`,
    [id, tenant, owner, kind, nameKey],
  );

describe.skipIf(!PG_URL)("entities and chunk_entities (needs DOCMIND_TEST_PG_URL)", () => {
  let db: TestDb;
  let app: Pool;
  const E1 = randomUUID();
  beforeAll(async () => {
    db = await createTestDb();
    await migrate(db.owner);
    await setAppRolePassword(db.owner, APP_PASSWORD);
    await seedUsers(db.owner);
    await db.owner.query(
      `INSERT INTO documents (id, tenant_id, owner_id, title_enc, filename_enc, mime, size_bytes, content_address, fingerprint)
       VALUES ($1, $2, $3, '{"x":1}', '{"x":2}', 'text/plain', 5, $4, $5)`,
      [DOC, T1, U1, `hmac-sha256:${hex("a")}`, hex("a")],
    );
    await db.owner.query(
      `INSERT INTO chunks (id, tenant_id, document_id, ordinal, section_ordinal, text_enc, locator, token_count)
       VALUES ($1, $2, $3, 0, 0, '{"x":1}', '{"kind":"chars","start":0,"end":5}', 2)`,
      [CHUNK, T1, DOC],
    );
    app = new Pool({ connectionString: db.appUrl });
  });
  afterAll(async () => {
    await app?.end();
    await db?.drop();
  });

  it("stores an entity and a mention, visible only inside their tenant", async () => {
    await withTenant(app, T1, async (tx) => {
      await insertEntity(tx, E1, T1, U1, hex("1"));
      await tx.query(
        "INSERT INTO chunk_entities (tenant_id, chunk_id, entity_id) VALUES ($1, $2, $3)",
        [T1, CHUNK, E1],
      );
    });
    const mine = await withTenant(app, T1, (tx) =>
      tx.query(
        "SELECT (SELECT count(*) FROM entities)::int AS e, (SELECT count(*) FROM chunk_entities)::int AS c",
      ),
    );
    expect(mine.rows[0]).toEqual({ e: 1, c: 1 });
    const other = await withTenant(app, T2, (tx) =>
      tx.query(
        "SELECT (SELECT count(*) FROM entities)::int AS e, (SELECT count(*) FROM chunk_entities)::int AS c",
      ),
    );
    expect(other.rows[0]).toEqual({ e: 0, c: 0 });
  });

  it("refuses writes for another tenant", async () => {
    await expect(
      withTenant(app, T2, (tx) => insertEntity(tx, randomUUID(), T1, U1, hex("2"))),
    ).rejects.toMatchObject({
      code: "42501",
      message: /row-level security policy for table "entities"/,
    });
  });

  it("refuses an unknown kind and a non-hex name key by constraint name", async () => {
    await expect(
      withTenant(app, T1, (tx) => insertEntity(tx, randomUUID(), T1, U1, hex("3"), "robot")),
    ).rejects.toMatchObject({ code: "23514", constraint: "entities_kind_check" });
    await expect(
      withTenant(app, T1, (tx) => insertEntity(tx, randomUUID(), T1, U1, "ZZ")),
    ).rejects.toMatchObject({ code: "23514", constraint: "entities_name_key_check" });
  });

  it("refuses a second entity with the same name key for one owner, but not for another owner", async () => {
    await expect(
      withTenant(app, T1, (tx) => insertEntity(tx, randomUUID(), T1, U1, hex("1"))),
    ).rejects.toMatchObject({ code: "23505", constraint: "entities_owner_name_key" });
    await withTenant(app, T1, (tx) => insertEntity(tx, randomUUID(), T1, U1B, hex("1")));
  });

  it("refuses an owner from another tenant (composite foreign key)", async () => {
    await expect(
      withTenant(app, T1, (tx) =>
        insertEntity(tx, randomUUID(), T1, "b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1", hex("4")),
      ),
    ).rejects.toMatchObject({ code: "23503", constraint: "entities_owner_fkey" });
  });

  it("deletes mentions with their chunk, and entities with their user", async () => {
    await withTenant(app, T1, (tx) => tx.query("DELETE FROM chunks WHERE id = $1", [CHUNK]));
    const left = await withTenant(app, T1, (tx) =>
      tx.query("SELECT count(*)::int AS n FROM chunk_entities"),
    );
    expect(left.rows[0].n).toBe(0);
    await db.owner.query("DELETE FROM users WHERE id = $1", [U1]);
    const ents = await db.owner.query(
      "SELECT count(*)::int AS n FROM entities WHERE owner_id = $1",
      [U1],
    );
    expect(ents.rows[0].n).toBe(0);
  });
});
