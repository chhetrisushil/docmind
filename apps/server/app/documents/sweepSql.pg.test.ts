import { randomUUID } from "node:crypto";
import { InMemoryKeyStore } from "@loom/plugin-crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FieldCrypto } from "../crypto/fields";
import { migrate, setAppRolePassword } from "../db/migrate";
import { APP_PASSWORD, PG_URL, type TestDb, createTestDb } from "../db/testSupport";
import { ingestExecutionId } from "./ingest";
import { ALICE, BOB, T1, T2, U1, U2, seedDoc, seedRow, seedUsers } from "./testHarness";

const DEFINERS = ["docmind_orphan_statuses", "docmind_stale_uploads_v2"];
const fn = (max = 10) =>
  `docmind_stale_uploads_v2(make_interval(secs => 120), make_interval(secs => 604800), ${max})`;

describe.skipIf(!PG_URL)("docmind_stale_uploads (needs DOCMIND_TEST_PG_URL)", () => {
  let db: TestDb;
  let owner: Pool;
  let app: Pool;
  let fields: FieldCrypto;
  let n = 0;
  const fp = () => (n++).toString(16).padStart(64, "0");

  beforeAll(async () => {
    db = await createTestDb();
    owner = db.owner;
    await migrate(owner);
    await setAppRolePassword(owner, APP_PASSWORD);
    await seedUsers(owner);
    app = new Pool({ connectionString: db.appUrl });
    fields = new FieldCrypto(new InMemoryKeyStore());
  });
  afterAll(async () => {
    await app.end();
    await db.drop();
  });

  it("lists documents that are old enough, recent enough and have no current-generation row, across tenants, newest first, limited", async () => {
    await owner.query("DELETE FROM documents");
    const aliceOld = await seedDoc(owner, app, fields, ALICE, fp(), 600);
    const stubOnly = await seedDoc(owner, app, fields, ALICE, fp(), 700);
    const bobOlder = await seedDoc(owner, app, fields, BOB, fp(), 900);
    const started = await seedDoc(owner, app, fields, ALICE, fp(), 800);
    await seedDoc(owner, app, fields, ALICE, fp(), 5); // fresh: inside the grace period
    await seedDoc(owner, app, fields, ALICE, fp(), 8 * 24 * 3600); // older than the lookback
    await seedRow(owner, ingestExecutionId(U1, stubOnly, 1), stubOnly, U1); // the M2 stub's execution does not count
    await seedRow(owner, ingestExecutionId(U1, started), started, U1); // the current generation: started, whatever its state
    const all = (await app.query(`SELECT * FROM ${fn()}`)).rows;
    expect(all.map((r) => r.id)).toEqual([aliceOld, stubOnly, bobOlder]);
    expect(all[2]).toEqual({ tenant_id: T2, owner_id: U2, id: bobOlder, generation: 2 });
    expect((await app.query(`SELECT * FROM ${fn(1)}`)).rows.map((r) => r.id)).toEqual([aliceOld]);
  });

  it("returns each stray's current generation, and finds a retried document whose new generation never started", async () => {
    await owner.query("DELETE FROM documents");
    const doc = await seedDoc(owner, app, fields, ALICE, fp(), 600);
    await seedRow(owner, ingestExecutionId(U1, doc, 2), doc, U1); // generation 2 ran
    expect((await app.query(`SELECT id FROM ${fn()}`)).rows).toEqual([]);
    await owner.query(
      "UPDATE documents SET ingest_generation = 3, updated_at = now() - interval '10 minutes' WHERE id = $1",
      [doc],
    );
    expect((await app.query(`SELECT id, generation FROM ${fn()}`)).rows).toEqual([
      { id: doc, generation: 3 },
    ]);
    await seedRow(owner, ingestExecutionId(U1, doc, 3), doc, U1);
    expect((await app.query(`SELECT id FROM ${fn()}`)).rows).toEqual([]);
  });

  it("uses updated_at for the age and lookback, so a retry long after upload is still swept", async () => {
    await owner.query("DELETE FROM documents");
    const doc = await seedDoc(owner, app, fields, ALICE, fp(), 30 * 24 * 3600); // created 30 days ago
    expect((await app.query(`SELECT id FROM ${fn()}`)).rows).toEqual([]);
    await owner.query(
      "UPDATE documents SET ingest_generation = 3, updated_at = now() - interval '10 minutes' WHERE id = $1",
      [doc],
    );
    expect((await app.query(`SELECT id FROM ${fn()}`)).rows).toEqual([{ id: doc }]);
  });

  it("no longer has the v1 function", async () => {
    const { rows } = await owner.query(
      "SELECT 1 FROM pg_proc WHERE proname = 'docmind_stale_uploads' AND pronamespace = 'public'::regnamespace",
    );
    expect(rows).toEqual([]);
  });

  it("a document recovery cancelled has a failed row and is not listed", async () => {
    await owner.query("DELETE FROM documents");
    const doc = await seedDoc(owner, app, fields, ALICE, fp(), 600);
    await seedRow(owner, ingestExecutionId(U1, doc), doc, U1, '{"failed":"internal"}');
    expect((await app.query(`SELECT * FROM ${fn()}`)).rows).toEqual([]);
  });

  it("the app role may run the function and PUBLIC may not", async () => {
    const sig = "docmind_stale_uploads_v2(interval, interval, integer)";
    const { rows } = await owner.query(
      `SELECT has_function_privilege('docmind_app', '${sig}', 'EXECUTE') AS app, has_function_privilege('public', '${sig}', 'EXECUTE') AS pub`,
    );
    expect(rows[0]).toEqual({ app: true, pub: false });
  });

  it("returns no rows for a NULL, out-of-range or huge argument, and clamps the limit to 500", async () => {
    await owner.query("DELETE FROM documents");
    await seedDoc(owner, app, fields, ALICE, fp(), 600);
    const call = async (a: (string | number | null)[]) =>
      (
        await app.query(
          "SELECT * FROM docmind_stale_uploads_v2($1::interval, $2::interval, $3::integer)",
          a,
        )
      ).rows;
    const ok = ["120 seconds", "7 days", 10];
    expect(await call(ok)).toHaveLength(1);
    const bad: (string | number | null)[][] = [
      [null, "7 days", 10],
      ["120 seconds", null, 10],
      ["120 seconds", "7 days", null],
      ["-1 hour", "7 days", 10],
      ["0 seconds", "100 years", 10],
      ["120 seconds", "401 days", 10],
    ];
    for (const a of bad) expect(await call(a)).toEqual([]);
    await owner.query(
      `INSERT INTO documents (id, tenant_id, owner_id, title_enc, filename_enc, mime, size_bytes, content_address, fingerprint, created_at, updated_at)
       SELECT gen_random_uuid(), '${T1}', '${U1}', '{}', '{}', 'text/plain', 1,
              'hmac-sha256:' || md5(g::text) || md5(g::text), md5(g::text) || md5(g::text), now() - interval '10 minutes', now() - interval '10 minutes'
         FROM generate_series(1, 501) g`,
    );
    expect(await call(["120 seconds", "7 days", 100000])).toHaveLength(500);
    expect(await call(["120 seconds", "7 days", 0])).toHaveLength(1);
    expect(await call(["120 seconds", "7 days", -5])).toHaveLength(1);
  });

  it("docmind_orphan_statuses lists live status rows whose document is gone or owned by someone else, and nothing else", async () => {
    await owner.query("DELETE FROM documents");
    await owner.query("DELETE FROM read_model_state");
    const kept = await seedDoc(owner, app, fields, ALICE, fp(), 600);
    const gone = randomUUID();
    const tombstoned = randomUUID();
    await seedRow(owner, ingestExecutionId(U1, kept), kept, U1);
    await seedRow(owner, ingestExecutionId(U2, kept), kept, U2); // the document exists, but not for this owner
    await seedRow(owner, ingestExecutionId(U1, gone), gone, U1);
    await seedRow(owner, ingestExecutionId(U1, gone, 3), gone, U1);
    await seedRow(owner, ingestExecutionId(U2, tombstoned), tombstoned, U2);
    await owner.query(
      "UPDATE read_model_state SET erased = true, state = NULL WHERE app_key = $1",
      [tombstoned],
    );
    const rows = (await app.query("SELECT * FROM docmind_orphan_statuses(10)")).rows;
    expect(rows.map((r) => r.execution_id)).toEqual(
      [
        ingestExecutionId(U2, kept),
        ingestExecutionId(U1, gone),
        ingestExecutionId(U1, gone, 3),
      ].sort(),
    );
    expect((await app.query("SELECT * FROM docmind_orphan_statuses(1)")).rows).toHaveLength(1);
  });

  it("docmind_orphan_statuses returns no rows for NULL and clamps the limit to 500", async () => {
    await owner.query("DELETE FROM read_model_state");
    await owner.query(
      `INSERT INTO read_model_state (model_id, execution_id, app_key, scope, sequence, state)
       SELECT 'ingest-status', 'u_${U1}:ingest-' || u, u, '${U1}', 0, '{}'
         FROM (SELECT gen_random_uuid()::text AS u FROM generate_series(1, 501)) x`,
    );
    const call = async (n: number | null) =>
      (await app.query("SELECT * FROM docmind_orphan_statuses($1::integer)", [n])).rows;
    expect(await call(null)).toEqual([]);
    expect(await call(100000)).toHaveLength(500);
    expect(await call(0)).toHaveLength(1);
    expect(await call(-5)).toHaveLength(1);
  });

  it("every docmind_ definer function pins its search_path and is executable by the app role alone", async () => {
    const { rows } = await owner.query(
      `SELECT p.proname, p.prosecdef, p.proconfig,
              pg_get_userbyid(p.proowner) AS owner,
              (SELECT array_agg(g ORDER BY g) FROM (
                 SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END || ':' || a.privilege_type AS g
                   FROM aclexplode(p.proacl) a) x) AS acl
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname LIKE 'docmind\_%' ORDER BY p.proname`,
    );
    expect(rows.map((r) => r.proname)).toEqual(DEFINERS);
    for (const r of rows) {
      expect(r.prosecdef).toBe(true);
      expect(r.proconfig).toEqual(["search_path=pg_catalog, pg_temp"]);
      expect(r.acl).toEqual([`${r.owner}:EXECUTE`, "docmind_app:EXECUTE"].sort());
    }
  });
});
