import { InMemoryKeyStore } from "@loom/plugin-crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FieldCrypto } from "../crypto/fields";
import { migrate, setAppRolePassword } from "../db/migrate";
import { APP_PASSWORD, PG_URL, type TestDb, createTestDb } from "../db/testSupport";
import { deterministicUser, legacyIngestId, legacyVisualizeId } from "../opaqueIds/testing";
import { PgExecutionRecorder } from "./executionIds";
import { ALICE, seedDoc, seedUsers } from "./testHarness";

const NIL = "00000000-0000-0000-0000-000000000000";
const READY = '{"status":"ready","step":"finalize","code":null}';
const sweeps = {
  ready: "docmind_ready_documents($1::uuid, 100)",
  retry: "docmind_visual_retry_documents($1::uuid, 100)",
  stale: "docmind_visual_stale_format_documents($1::uuid, 100, 'current')",
  unrecorded: "docmind_visual_unrecorded_documents($1::uuid, 100)",
} as const;

/**
 * The five sweeps compare the id STORED on the document (migration 0038), because a new-format id cannot be built in SQL. Until the
 * new-format ids were recorded the stored id and the rebuilt old-format id were the same string, so no test could tell the two apart.
 * Each case below stores a new-format id and puts a status row under the OLD-format id the sweep used to rebuild: a sweep that still
 * rebuilt the old id would answer the other way.
 */
describe.skipIf(!PG_URL)(
  "the sweeps compare the stored new-format id (needs DOCMIND_TEST_PG_URL)",
  () => {
    let db: TestDb;
    let owner: Pool;
    let app: Pool;
    let fields: FieldCrypto;
    let recorder: PgExecutionRecorder;
    let n = 0;
    const fp = () => (n++ + 5000).toString(16).padStart(64, "0");
    const user = deterministicUser(ALICE.userId);

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

    const status = (executionId: string, key: string, state = READY) =>
      owner.query(
        "INSERT INTO read_model_state (model_id, execution_id, app_key, scope, sequence, state) VALUES ('ingest-status', $1, $2, $3, 0, $4)",
        [executionId, key, ALICE.userId, state],
      );

    /** A document that recorded its new-format ids (as the starters now do). Returns its id and generation. */
    const recorded = async (ageSeconds = 600) => {
      const id = await seedDoc(owner, app, fields, ALICE, fp(), ageSeconds);
      const { rows } = await owner.query(
        "SELECT ingest_generation AS g FROM documents WHERE id = $1",
        [id],
      );
      const g = Number(rows[0].g);
      await recorder.recordIngest(ALICE, id, g, user.ingest(id, g));
      await recorder.recordVisualize(ALICE, id, g, user.visualize(id, g));
      return { id, g };
    };
    const listed = async (sweep: keyof typeof sweeps) =>
      (await app.query(`SELECT id FROM ${sweeps[sweep]}`, [NIL])).rows.map((r) => r.id as string);
    const staleUploads = async () =>
      (
        await app.query(
          "SELECT id FROM docmind_stale_uploads_v2(make_interval(secs => 120), make_interval(secs => 604800), 100)",
        )
      ).rows.map((r) => r.id as string);
    const clear = async () => {
      await owner.query("DELETE FROM visual_runs");
      await owner.query("DELETE FROM read_model_state");
      await owner.query("DELETE FROM documents");
    };

    it("stale-upload sweep: a document is started again until a status row exists under its STORED id", async () => {
      await clear();
      const d = await recorded();
      expect(await staleUploads()).toEqual([d.id]); // no row under the stored id
      await status(legacyIngestId(ALICE.userId, d.id, d.g), d.id, "{}"); // the id a rebuild would look for
      expect(await staleUploads()).toEqual([d.id]); // still listed: the old-format row is not its run
      await status(user.ingest(d.id, d.g), d.id, "{}");
      expect(await staleUploads()).toEqual([]);
    });

    it("ready sweep: lists a ready document by its stored ingest id and leaves it only when a row exists under its stored visualize id", async () => {
      await clear();
      const onlyOld = await recorded();
      await status(legacyIngestId(ALICE.userId, onlyOld.id, onlyOld.g), onlyOld.id); // ready, but under the old id
      expect(await listed("ready")).toEqual([]); // a rebuilt old id would have found it

      const d = await recorded();
      await status(user.ingest(d.id, d.g), d.id);
      // A visualize row under the OLD id is not this document's run: a rebuild would have hidden it.
      await status(legacyVisualizeId(ALICE.userId, d.id, d.g), d.id, "{}");
      expect(await listed("ready")).toEqual([d.id]);
      await status(user.visualize(d.id, d.g), d.id, "{}");
      expect(await listed("ready")).toEqual([]);
    });

    const visualRun = (id: string, state: string, extra: string) =>
      owner.query(
        `INSERT INTO visual_runs (document_id, generation, tenant_id, owner_id, run, state, ${extra.split("=")[0]})
       SELECT id, ingest_generation, tenant_id, owner_id, 0, $2, ${extra.split("=")[1]} FROM documents WHERE id = $1`,
        [id, state],
      );

    it("retry sweep: needs a ready row under the stored ingest id", async () => {
      await clear();
      const onlyOld = await recorded();
      await visualRun(onlyOld.id, "failed", "code='visuals-model-unavailable'");
      await status(legacyIngestId(ALICE.userId, onlyOld.id, onlyOld.g), onlyOld.id);
      const d = await recorded();
      await visualRun(d.id, "failed", "code='visuals-model-unavailable'");
      await status(user.ingest(d.id, d.g), d.id);
      await owner.query("UPDATE visual_runs SET updated_at = now() - interval '2 hours'");
      expect(await listed("retry")).toEqual([d.id]);
    });

    it("stale-format sweep: needs a ready row under the stored ingest id", async () => {
      await clear();
      const onlyOld = await recorded();
      await visualRun(onlyOld.id, "done", "format='old'");
      await status(legacyIngestId(ALICE.userId, onlyOld.id, onlyOld.g), onlyOld.id);
      const d = await recorded();
      await visualRun(d.id, "done", "format='old'");
      await status(user.ingest(d.id, d.g), d.id);
      expect(await listed("stale")).toEqual([d.id]);
    });

    it("unrecorded sweep: needs a ready row under the stored ingest id AND a row under the stored visualize id", async () => {
      await clear();
      const onlyOld = await recorded();
      await status(legacyIngestId(ALICE.userId, onlyOld.id, onlyOld.g), onlyOld.id);
      await status(legacyVisualizeId(ALICE.userId, onlyOld.id, onlyOld.g), onlyOld.id, "{}");
      const visualizeOld = await recorded();
      await status(user.ingest(visualizeOld.id, visualizeOld.g), visualizeOld.id);
      await status(
        legacyVisualizeId(ALICE.userId, visualizeOld.id, visualizeOld.g),
        visualizeOld.id,
        "{}",
      );
      const d = await recorded();
      await status(user.ingest(d.id, d.g), d.id);
      await status(user.visualize(d.id, d.g), d.id, "{}");
      expect(await listed("unrecorded")).toEqual([d.id]);
    });
  },
);
