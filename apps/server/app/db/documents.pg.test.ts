import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, setAppRolePassword } from "./migrate";
import { withTenant } from "./tenant";
import { APP_PASSWORD, PG_URL, type TestDb, createTestDb } from "./testSupport";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const USER_A = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
const USER_A2 = "a2a2a2a2-a2a2-4a2a-8a2a-a2a2a2a2a2a2";
const USER_B = "b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1";
const HEX = (c: string) => c.repeat(64);

const insert = (
  tx: { query: Pool["query"] },
  id: string,
  tenant: string,
  owner: string,
  fingerprint: string,
  extra: { status?: string; size?: number; address?: string } = {},
) =>
  tx.query(
    `INSERT INTO documents (id, tenant_id, owner_id, title_enc, filename_enc, mime, size_bytes,
                            content_address, fingerprint, status)
     VALUES ($1, $2, $3, '{"x":1}', '{"x":2}', 'text/plain', $4, $5, $6, $7)`,
    [
      id,
      tenant,
      owner,
      extra.size ?? 5,
      extra.address ?? `hmac-sha256:${fingerprint}`,
      fingerprint,
      extra.status ?? "uploaded",
    ],
  );

describe.skipIf(!PG_URL)("documents table (needs DOCMIND_TEST_PG_URL)", () => {
  let db: TestDb;
  let app: Pool;

  beforeAll(async () => {
    db = await createTestDb();
    await migrate(db.owner);
    await setAppRolePassword(db.owner, APP_PASSWORD);
    await db.owner.query(`
      INSERT INTO tenants (id, name) VALUES ('${A}', 'A'), ('${B}', 'B');
      INSERT INTO users (id, tenant_id, email, password_hash) VALUES
        ('${USER_A}', '${A}', 'a@example.com', 'x'), ('${USER_A2}', '${A}', 'a2@example.com', 'x'),
        ('${USER_B}', '${B}', 'b@example.com', 'x');`);
    app = new Pool({ connectionString: db.appUrl, max: 1 });
    await withTenant(app, A, (tx) =>
      insert(tx, "10000000-0000-4000-8000-000000000001", A, USER_A, HEX("a")),
    );
    await withTenant(app, B, (tx) =>
      insert(tx, "20000000-0000-4000-8000-000000000001", B, USER_B, HEX("a")),
    );
  });

  afterAll(async () => {
    await app?.end();
    await db?.drop();
  });

  it("shows each tenant only its own rows, and none outside a tenant context", async () => {
    await withTenant(app, A, async (tx) => {
      const { rows } = await tx.query("SELECT tenant_id FROM documents");
      expect(rows).toEqual([{ tenant_id: A }]);
    });
    await withTenant(app, B, async (tx) => {
      const { rows } = await tx.query("SELECT tenant_id FROM documents");
      expect(rows).toEqual([{ tenant_id: B }]);
    });
    expect((await app.query("SELECT 1 FROM documents")).rowCount).toBe(0); // raw SQL, no tenant set
  });

  it("refuses to write a row for another tenant, or to move one there", async () => {
    await expect(
      withTenant(app, A, (tx) =>
        insert(tx, "10000000-0000-4000-8000-000000000002", B, USER_B, HEX("b")),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      withTenant(app, A, (tx) => tx.query("UPDATE documents SET tenant_id = $1", [B])),
    ).rejects.toThrow(/row-level security/);
  });

  it("makes the same bytes unique per owner, not per tenant or across tenants", async () => {
    await expect(
      withTenant(app, A, (tx) =>
        insert(tx, "10000000-0000-4000-8000-000000000003", A, USER_A, HEX("a")),
      ),
    ).rejects.toThrow(/documents_owner_fingerprint_key/);
    // another user of the same tenant may hold the same bytes (dedup is per user)
    await withTenant(app, A, (tx) =>
      insert(tx, "10000000-0000-4000-8000-000000000004", A, USER_A2, HEX("a")),
    );
  });

  it("requires the owner to be a user of the same tenant", async () => {
    await expect(
      withTenant(app, A, (tx) =>
        insert(tx, "10000000-0000-4000-8000-000000000005", A, USER_B, HEX("c")),
      ),
    ).rejects.toThrow(/documents_owner_fkey/);
  });

  it("rejects malformed values at the database", async () => {
    const bad = (fp: string, extra: { status?: string; size?: number; address?: string }) =>
      withTenant(app, A, (tx) =>
        insert(tx, "10000000-0000-4000-8000-0000000000ff", A, USER_A, fp, extra),
      );
    await expect(bad(HEX("d"), { status: "done" })).rejects.toThrow(/status/);
    await expect(bad(HEX("d"), { size: -1 })).rejects.toThrow(/size_bytes/);
    await expect(bad("NOT-HEX", { address: `hmac-sha256:${HEX("d")}` })).rejects.toThrow(
      /documents_fingerprint_check/,
    );
  });

  it("accepts only keyed addresses and has no plaintext stats column", async () => {
    await expect(
      withTenant(app, A, (tx) =>
        tx.query(
          `INSERT INTO documents (id, tenant_id, owner_id, title_enc, filename_enc, mime, size_bytes,
                                  content_address, fingerprint)
           VALUES ('10000000-0000-4000-8000-0000000000aa', $1, $2, '{}', '{}', 'text/plain', 1, $3, $4)`,
          [A, USER_A, `sha256:${HEX("e")}`, HEX("e")], // the plain scheme is refused
        ),
      ),
    ).rejects.toThrow(/content_address/);
    const cols = await db.owner.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'documents'",
    );
    const names = cols.rows.map((r) => r.column_name as string);
    expect(names).toContain("stats_enc");
    expect(names).not.toContain("stats");
  });

  it("is removed with its owner, and docmind_app owns nothing", async () => {
    await db.owner.query("DELETE FROM users WHERE id = $1", [USER_A2]);
    const { rows } = await db.owner.query(
      "SELECT count(*)::int AS n FROM documents WHERE owner_id = $1",
      [USER_A2],
    );
    expect(rows[0].n).toBe(0);
    const owned = await db.owner.query(
      "SELECT 1 FROM pg_tables WHERE tablename = 'documents' AND tableowner = 'docmind_app'",
    );
    expect(owned.rowCount).toBe(0);
  });
});
