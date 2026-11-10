import { InMemoryKeyStore } from "@loom/plugin-crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FieldCrypto } from "../crypto/fields";
import { PgExecutionRecorder, repairStoredExecutionIds } from "../documents/executionIds";
import { bumpGeneration } from "../documents/repo";
import {
  ALICE,
  BOB,
  U1,
  U2,
  backfillExecutionIds,
  seedDoc,
  seedRow,
  seedUsers,
} from "../documents/testHarness";
import { legacyIds } from "../opaqueIds";
import { migrate, setAppRolePassword } from "./migrate";
import { withTenant } from "./tenant";
import { APP_PASSWORD, PG_URL, type TestDb, createTestDb } from "./testSupport";

const NIL = "00000000-0000-0000-0000-000000000000";
const READY = '{"status":"ready","step":"finalize","code":null}';
// What the application records for a new-format start: any opaque text; the SQL only compares it.
const opaque = (d: string, kind: string) =>
  `h_${"a".repeat(26)}:${kind}-${d.replaceAll("-", "").padEnd(52, "a")}.2`;

describe.skipIf(!PG_URL)(
  "documents.*_execution_id and the sweeps that read them (needs DOCMIND_TEST_PG_URL)",
  () => {
    let db: TestDb;
    let owner: Pool;
    let app: Pool;
    let fields: FieldCrypto;
    let recorder: PgExecutionRecorder;
    let n = 0;
    const fp = () => (n++).toString(16).padStart(64, "0");
    const column = async (id: string) =>
      (
        await owner.query(
          "SELECT ingest_execution_id AS i, visualize_execution_id AS v FROM documents WHERE id = $1",
          [id],
        )
      ).rows[0];

    beforeAll(async () => {
      db = await createTestDb();
      owner = db.owner;
      await migrate(owner);
      await setAppRolePassword(owner, APP_PASSWORD);
      await seedUsers(owner);
      app = new Pool({ connectionString: db.appUrl });
      fields = new FieldCrypto(new InMemoryKeyStore());
      recorder = new PgExecutionRecorder(app);
    });
    afterAll(async () => {
      await app.end();
      await db.drop();
    });

    it("records an id once per generation, only for the owner, and bumpGeneration clears both", async () => {
      const id = await seedDoc(owner, app, fields, ALICE, fp(), 600);
      expect(await column(id)).toEqual({ i: null, v: null });
      await recorder.recordIngest(ALICE, id, 2, opaque(id, "ingest"));
      await recorder.recordVisualize(ALICE, id, 2, opaque(id, "visualize"));
      await recorder.recordIngest(ALICE, id, 2, "h_other"); // a second record never overwrites
      expect(await column(id)).toEqual({ i: opaque(id, "ingest"), v: opaque(id, "visualize") });
      await recorder.recordIngest(ALICE, id, 3, "h_wrong-generation"); // not the current generation
      await recorder.recordIngest({ tenantId: BOB.tenantId, userId: U2 }, id, 2, "h_not-the-owner");
      expect((await column(id)).i).toBe(opaque(id, "ingest"));
      await withTenant(app, ALICE.tenantId, (tx) => bumpGeneration(tx, id, U1, 2));
      expect(await column(id)).toEqual({ i: null, v: null });
      await recorder.recordIngest(ALICE, id, 3, opaque(id, "ingest").replace(".2", ".3"));
      expect((await column(id)).i).toContain(".3");
    });

    it("the migration's backfill gives a document with an old-format status row that exact id, and no other document anything", async () => {
      const withRow = await seedDoc(owner, app, fields, ALICE, fp(), 600);
      const without = await seedDoc(owner, app, fields, ALICE, fp(), 600);
      await seedRow(owner, legacyIds.ingest(U1, withRow, 2), withRow, U1, READY);
      await backfillExecutionIds(owner);
      expect((await column(withRow)).i).toBe(legacyIds.ingest(U1, withRow, 2));
      expect((await column(without)).i).toBeNull();
    });

    it("the backfill is idempotent: it never overwrites a recorded id (not even with seedRow's own sync), and a second run changes nothing", async () => {
      const id = await seedDoc(owner, app, fields, ALICE, fp(), 600);
      await recorder.recordIngest(ALICE, id, 2, opaque(id, "ingest"));
      await recorder.recordVisualize(ALICE, id, 2, opaque(id, "visualize"));
      // An old-format row for the same generation appears later (a replayed log, an old pod): the recorded new-format ids stay.
      await seedRow(owner, legacyIds.ingest(U1, id, 2), id, U1, READY);
      await seedRow(owner, legacyIds.visualize(U1, id, 2), id, U1);
      await backfillExecutionIds(owner);
      expect(await column(id)).toEqual({ i: opaque(id, "ingest"), v: opaque(id, "visualize") });
      const again = await owner.query("SELECT public.docmind_repair_execution_ids() AS n");
      expect(again.rows[0].n).toBe(0);
    });

    it("the boot repair (repairStoredExecutionIds, on the app role) repairs a document an OLD pod ingested after the migration, and the stale sweep stops listing it", async () => {
      const id = await seedDoc(owner, app, fields, ALICE, fp(), 600);
      // What an old pod leaves behind: the old-format status row, and a NULL column (it never writes it). Not `seedRow`: that repairs.
      await owner.query(
        "INSERT INTO read_model_state (model_id, execution_id, app_key, scope, sequence, state) VALUES ('ingest-status', $1, $2, $3, 0, $4)",
        [legacyIds.ingest(U1, id, 2), id, U1, READY],
      );
      expect((await column(id)).i).toBeNull();
      const stale = async () =>
        (
          await app.query(
            "SELECT id FROM docmind_stale_uploads_v2(make_interval(secs => 120), make_interval(secs => 604800), 500)",
          )
        ).rows.map((r) => r.id);
      // Before the repair the sweep cannot match the old-format row: it would start a second ingest under a new-format id.
      expect(await stale()).toContain(id);
      expect(await repairStoredExecutionIds(app)).toBeGreaterThanOrEqual(1);
      expect((await column(id)).i).toBe(legacyIds.ingest(U1, id, 2));
      expect(await stale()).not.toContain(id);
      expect(await repairStoredExecutionIds(app)).toBe(0); // idempotent
    });

    it("docmind_ready_documents compares the stored ids: old and new format both match, a NULL never does", async () => {
      await owner.query("DELETE FROM documents");
      await owner.query("DELETE FROM read_model_state");
      const oldFormat = await seedDoc(owner, app, fields, ALICE, fp(), 600);
      const newFormat = await seedDoc(owner, app, fields, ALICE, fp(), 600);
      const unrecorded = await seedDoc(owner, app, fields, ALICE, fp(), 600);
      const visualized = await seedDoc(owner, app, fields, ALICE, fp(), 600);
      await seedRow(owner, legacyIds.ingest(U1, oldFormat, 2), oldFormat, U1, READY);
      await owner.query("UPDATE documents SET ingest_execution_id = $2 WHERE id = $1", [
        oldFormat,
        legacyIds.ingest(U1, oldFormat, 2),
      ]);
      await seedRow(owner, opaque(newFormat, "ingest"), newFormat, U1, READY);
      await recorder.recordIngest(ALICE, newFormat, 2, opaque(newFormat, "ingest"));
      await seedRow(owner, opaque(unrecorded, "ingest"), unrecorded, U1, READY); // a row, but no id recorded on the document
      await seedRow(owner, opaque(visualized, "ingest"), visualized, U1, READY);
      await recorder.recordIngest(ALICE, visualized, 2, opaque(visualized, "ingest"));
      await recorder.recordVisualize(ALICE, visualized, 2, opaque(visualized, "visualize"));
      // Loom's neutral row for the visualize execution itself.
      await owner.query(
        "INSERT INTO read_model_state (model_id, execution_id, app_key, scope, sequence, state) VALUES ('ingest-status', $1, NULL, NULL, 0, '{}')",
        [opaque(visualized, "visualize")],
      );
      const { rows } = await app.query("SELECT id FROM docmind_ready_documents($1::uuid, 100)", [
        NIL,
      ]);
      expect(rows.map((r) => r.id).sort()).toEqual([oldFormat, newFormat].sort());
    });

    it("the stale-upload sweep lists a document whose recorded id has no status row, and not one that has", async () => {
      await owner.query("DELETE FROM documents");
      await owner.query("DELETE FROM read_model_state");
      const started = await seedDoc(owner, app, fields, ALICE, fp(), 600);
      const notStarted = await seedDoc(owner, app, fields, ALICE, fp(), 600);
      await recorder.recordIngest(ALICE, started, 2, opaque(started, "ingest"));
      await seedRow(owner, opaque(started, "ingest"), started, U1);
      await recorder.recordIngest(ALICE, notStarted, 2, opaque(notStarted, "ingest"));
      const { rows } = await app.query(
        "SELECT id FROM docmind_stale_uploads_v2(make_interval(secs => 120), make_interval(secs => 604800), 10)",
      );
      expect(rows.map((r) => r.id)).toEqual([notStarted]);
    });
  },
);
