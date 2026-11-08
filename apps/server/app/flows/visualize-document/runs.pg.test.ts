import { factFormatFingerprint } from "@docmind/experiences";
import { InMemoryKeyStore } from "@loom/plugin-crypto";
import type { WorkflowRuntime } from "@loom/workflow-runtime";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FieldCrypto } from "../../crypto/fields";
import { migrate, setAppRolePassword } from "../../db/migrate";
import { APP_PASSWORD, PG_URL, type TestDb, createTestDb } from "../../db/testSupport";
import { ingestExecutionId } from "../../documents/ingest";
import { ALICE, BOB, U1, U2, seedDoc, seedRow, seedUsers } from "../../documents/testHarness";
import { visualizeDocumentFlow } from "./flow";
import { PgVisualRuns } from "./runs";
import {
  loomVisualsStarter,
  pgReadyDocuments,
  pgRetryDocuments,
  pgRunningRuns,
  pgStaleFormatDocuments,
  visualizeExecutionId,
} from "./start";

const NIL = "00000000-0000-0000-0000-000000000000";

describe.skipIf(!PG_URL)("visual_runs and its functions (needs DOCMIND_TEST_PG_URL)", () => {
  let db: TestDb;
  let owner: Pool;
  let app: Pool;
  let fields: FieldCrypto;
  let runs: PgVisualRuns;
  let n = 0;
  const fp = () => (n++).toString(16).padStart(64, "0");
  const ready = '{"status":"ready","step":"finalize","code":null}';

  beforeAll(async () => {
    db = await createTestDb();
    owner = db.owner;
    await migrate(owner);
    await setAppRolePassword(owner, APP_PASSWORD);
    await seedUsers(owner);
    app = new Pool({ connectionString: db.appUrl });
    fields = new FieldCrypto(new InMemoryKeyStore());
    runs = new PgVisualRuns(app);
  });
  afterAll(async () => {
    await app.end();
    await db.drop();
  });

  const generationOf = async (id: string) =>
    Number(
      (await owner.query("SELECT ingest_generation FROM documents WHERE id = $1", [id])).rows[0]
        .ingest_generation,
    );
  const readyDoc = async (who = ALICE) => {
    const id = await seedDoc(owner, app, fields, who, fp(), 600);
    const g = await generationOf(id);
    await seedRow(owner, ingestExecutionId(who.userId, id, g), id, who.userId, ready);
    return { id, g };
  };
  const rowOf = async (id: string) =>
    (await owner.query("SELECT run, state, code FROM visual_runs WHERE document_id = $1", [id]))
      .rows;

  it("records a run of a live document's current generation, owner-checked, with the tenant from the document", async () => {
    const { id, g } = await readyDoc();
    await runs.record(
      { userId: U1, documentId: id, generation: g, run: 0 },
      "failed",
      "visuals-model-unavailable",
    );
    expect(await rowOf(id)).toEqual([
      { run: 0, state: "failed", code: "visuals-model-unavailable" },
    ]);
    expect(
      (
        await owner.query("SELECT tenant_id, owner_id FROM visual_runs WHERE document_id = $1", [
          id,
        ])
      ).rows,
    ).toEqual([{ tenant_id: ALICE.tenantId, owner_id: U1 }]);
  });

  it("writes nothing for another owner, another generation or an unknown document", async () => {
    const { id, g } = await readyDoc();
    await runs.record({ userId: U2, documentId: id, generation: g, run: 0 }, "failed");
    await runs.record({ userId: U1, documentId: id, generation: g + 1, run: 0 }, "failed");
    await runs.record(
      { userId: U1, documentId: "00000000-0000-4000-8000-000000000999", generation: 1, run: 0 },
      "failed",
    );
    expect(await rowOf(id)).toEqual([]);
  });

  it("keeps the newest run: a late event of an older run, or a finished run put back to running, changes nothing", async () => {
    const { id, g } = await readyDoc();
    const at = (run: number) => ({ userId: U1, documentId: id, generation: g, run });
    await runs.record(at(0), "failed", "visuals-model-unavailable");
    await runs.record(at(1), "running");
    expect(await rowOf(id)).toEqual([{ run: 1, state: "running", code: null }]);
    await runs.record(at(0), "failed", "visuals-model-unavailable"); // the old run's late event
    expect(await rowOf(id)).toEqual([{ run: 1, state: "running", code: null }]);
    await runs.record(at(1), "done");
    await runs.record(at(1), "running"); // the start of run 1 raced its own end
    expect(await rowOf(id)).toEqual([{ run: 1, state: "done", code: null }]);
    await runs.record(at(2), "running");
    expect(await rowOf(id)).toEqual([{ run: 2, state: "running", code: null }]);
  });

  it("refuses a state or code outside the lists", async () => {
    const { id, g } = await readyDoc();
    await expect(
      runs.record({ userId: U1, documentId: id, generation: g, run: 0 }, "weird" as never),
    ).rejects.toThrow();
    await expect(
      runs.record(
        { userId: U1, documentId: id, generation: g, run: 0 },
        "failed",
        "Zebra text" as never,
      ),
    ).rejects.toThrow();
  });

  it("last answers the owner's row only, under RLS", async () => {
    const { id, g } = await readyDoc();
    await runs.record(
      { userId: U1, documentId: id, generation: g, run: 3 },
      "failed",
      "visuals-plan-invalid",
    );
    expect(await runs.last(ALICE, id, g)).toEqual({
      run: 3,
      state: "failed",
      code: "visuals-plan-invalid",
    });
    expect(await runs.last(ALICE, id, g + 1)).toBeNull();
    expect(await runs.last(BOB, id, g)).toBeNull(); // another tenant: RLS hides the row
    expect(await runs.last({ ...ALICE, userId: U2 }, id, g)).toBeNull(); // another user: the owner filter
  });

  it("is removed with its document", async () => {
    const { id, g } = await readyDoc();
    await runs.record({ userId: U1, documentId: id, generation: g, run: 0 }, "done");
    await owner.query("DELETE FROM documents WHERE id = $1", [id]);
    expect(await rowOf(id)).toEqual([]);
  });

  it("docmind_visual_retry_documents lists ready documents whose last run ended visuals-model-unavailable, across tenants, paged", async () => {
    await owner.query("DELETE FROM documents");
    const unavailable = await readyDoc();
    const otherTenant = await readyDoc(BOB);
    const planInvalid = await readyDoc();
    const running = await readyDoc();
    const recovered = await readyDoc();
    const noRun = await readyDoc();
    const notReady = await seedDoc(owner, app, fields, ALICE, fp(), 600); // failed run but ingest not ready
    const rec = (
      who: string,
      d: { id: string; g: number },
      run: number,
      state: never,
      code?: never,
    ) => runs.record({ userId: who, documentId: d.id, generation: d.g, run }, state, code);
    await rec(U1, unavailable, 0, "failed" as never, "visuals-model-unavailable" as never);
    await rec(U2, otherTenant, 0, "failed" as never, "visuals-model-unavailable" as never);
    await rec(U1, planInvalid, 0, "failed" as never, "visuals-plan-invalid" as never);
    await rec(U1, running, 0, "failed" as never, "visuals-model-unavailable" as never);
    await rec(U1, running, 1, "running" as never);
    await rec(U1, recovered, 0, "failed" as never, "visuals-model-unavailable" as never);
    await rec(U1, recovered, 1, "done" as never);
    void noRun;
    await owner.query(
      "INSERT INTO visual_runs (document_id, generation, tenant_id, owner_id, run, state, code) SELECT id, ingest_generation, tenant_id, owner_id, 0, 'failed', 'visuals-model-unavailable' FROM documents WHERE id = $1",
      [notReady],
    );
    await owner.query("UPDATE visual_runs SET updated_at = now() - interval '2 hours'");
    const list = pgRetryDocuments(app);
    const all = await list(NIL, 100);
    expect(all.map((d) => d.documentId)).toEqual([unavailable.id, otherTenant.id].sort());
    expect(all.find((d) => d.documentId === unavailable.id)).toEqual({
      tenantId: ALICE.tenantId,
      userId: U1,
      documentId: unavailable.id,
      generation: unavailable.g,
    });
    const first = await list(NIL, 1);
    const second = await list(first[0]?.documentId as string, 1);
    expect([first[0]?.documentId, second[0]?.documentId]).toEqual(
      [unavailable.id, otherTenant.id].sort(),
    );
    expect(await list(second[0]?.documentId as string, 1)).toEqual([]);
    // The first-run source is not confused by it: these documents have no visualize execution row, so they are listed there too.
    expect((await pgReadyDocuments(app)(NIL, 100)).length).toBeGreaterThanOrEqual(2);
  });

  it("docmind_visual_running_runs lists the running rows of current generations, across tenants, paged, with the run number", async () => {
    await owner.query("DELETE FROM documents");
    const a = await readyDoc();
    const b = await readyDoc(BOB);
    const done = await readyDoc();
    const at = (who: string, d: { id: string; g: number }, run: number) => ({
      userId: who,
      documentId: d.id,
      generation: d.g,
      run,
    });
    await runs.record(at(U1, a, 2), "running");
    await runs.record(at(U2, b, 0), "running");
    await runs.record(at(U1, done, 1), "done");
    const list = pgRunningRuns(app);
    const all = await list(NIL, 100);
    expect(all.map((d) => [d.documentId, d.run])).toEqual(
      [
        [a.id, 2],
        [b.id, 0],
      ].sort((x, y) => String(x[0]).localeCompare(String(y[0]))),
    );
    const first = await list(NIL, 1);
    expect(await list(first[0]?.documentId as string, 5)).toHaveLength(1);
    expect((await app.query("SELECT * FROM docmind_visual_running_runs(NULL, 10)")).rows).toEqual(
      [],
    );
  });

  const formatOf = async (id: string) =>
    (await owner.query("SELECT format FROM visual_runs WHERE document_id = $1", [id])).rows[0]
      ?.format ?? null;

  it("stamps the format only on a run that ends done; any other run keeps the last stamp", async () => {
    await owner.query("DELETE FROM documents");
    const d = await readyDoc();
    const at = (run: number) => ({ userId: U1, documentId: d.id, generation: d.g, run });
    await runs.record(at(0), "running", undefined, "fmt-a");
    expect(await formatOf(d.id)).toBeNull(); // a non-done state never stores a format
    await runs.record(at(0), "done", undefined, "fmt-a");
    expect(await formatOf(d.id)).toBe("fmt-a");
    await runs.record(at(1), "running");
    await runs.record(at(1), "failed", "visuals-model-unavailable", "fmt-b");
    expect(await formatOf(d.id)).toBe("fmt-a");
    await runs.record(at(2), "empty");
    expect(await formatOf(d.id)).toBe("fmt-a");
    await runs.record(at(3), "done", undefined, "fmt-b");
    expect(await formatOf(d.id)).toBe("fmt-b");
    await runs.record(at(4), "done"); // no format given: keeps the stamp
    expect(await formatOf(d.id)).toBe("fmt-b");
  });

  it("docmind_visual_stale_format_documents lists done runs with a different or no format (NULL is stale since 0032), across tenants, paged, ids only", async () => {
    await owner.query("DELETE FROM documents");
    const stale = await readyDoc();
    const staleB = await readyDoc(BOB);
    const current = await readyDoc();
    const unstamped = await readyDoc(); // done, format NULL (recorded before stamping existed, or by a boot reconcile): stale since 0032
    const empty = await readyDoc();
    const failed = await readyDoc();
    const notReady = await seedDoc(owner, app, fields, ALICE, fp(), 600);
    const at = (who: string, d: { id: string; g: number }) => ({
      userId: who,
      documentId: d.id,
      generation: d.g,
      run: 0,
    });
    await runs.record(at(U1, stale), "done", undefined, "old");
    await runs.record(at(U2, staleB), "done", undefined, "old");
    await runs.record(at(U1, current), "done", undefined, "now");
    await runs.record(at(U1, unstamped), "done");
    await runs.record(at(U1, empty), "empty");
    await runs.record(at(U1, failed), "done", undefined, "old");
    await runs.record({ ...at(U1, failed), run: 1 }, "failed", "visuals-plan-invalid");
    await owner.query(
      "INSERT INTO visual_runs (document_id, generation, tenant_id, owner_id, run, state, format) SELECT id, ingest_generation, tenant_id, owner_id, 0, 'done', 'old' FROM documents WHERE id = $1",
      [notReady],
    );
    const list = pgStaleFormatDocuments(app, "now");
    const all = await list(NIL, 100);
    expect(all.map((d) => d.documentId)).toEqual([stale.id, staleB.id, unstamped.id].sort());
    expect(all.find((d) => d.documentId === stale.id)).toEqual({
      tenantId: ALICE.tenantId,
      userId: U1,
      documentId: stale.id,
      generation: stale.g,
    });
    const first = await list(NIL, 1);
    const second = await list(first[0]?.documentId as string, 1);
    const third = await list(second[0]?.documentId as string, 1);
    expect([first[0]?.documentId, second[0]?.documentId, third[0]?.documentId]).toEqual(
      [stale.id, staleB.id, unstamped.id].sort(),
    );
    expect(await list(third[0]?.documentId as string, 1)).toEqual([]);
    expect(
      (await app.query("SELECT * FROM docmind_visual_stale_format_documents(NULL, 10, 'now')"))
        .rows,
    ).toEqual([]);
    expect(
      (await app.query("SELECT * FROM docmind_visual_stale_format_documents($1, 10, NULL)", [NIL]))
        .rows,
    ).toEqual([]);
    // A document whose generation moved on is left out (a user being erased: see the final retry test).
    await owner.query(
      "UPDATE documents SET ingest_generation = ingest_generation + 1 WHERE id = $1",
      [stale.id],
    );
    expect((await list(NIL, 100)).map((d) => d.documentId)).toEqual(
      [staleB.id, unstamped.id].sort(),
    );
  });

  it("lists a NULL-format done run for the current fingerprint until a done run stamps it, then never again (the re-plan happens once)", async () => {
    await owner.query("DELETE FROM documents");
    const d = await readyDoc();
    const at = (run: number) => ({ userId: U1, documentId: d.id, generation: d.g, run });
    await runs.record(at(0), "done"); // recorded before stamping existed (or by a boot reconcile): no format
    const list = pgStaleFormatDocuments(app); // the current fingerprint
    expect((await list(NIL, 10)).map((x) => x.documentId)).toEqual([d.id]);
    await runs.record(at(1), "running"); // the boot pass starts the re-plan
    expect(await list(NIL, 10)).toEqual([]); // a running run is not `done`: not listed again mid-run
    await runs.record(at(1), "done", undefined, factFormatFingerprint());
    expect(await list(NIL, 10)).toEqual([]);
    expect(await pgStaleFormatDocuments(app, "docmind:other@2")(NIL, 10)).toHaveLength(1);
  });

  it("the boot stale pass re-runs a NULL-format done run once, the end stamps it, and the next sweep leaves it", async () => {
    await owner.query("DELETE FROM documents");
    const d = await readyDoc();
    await runs.record({ userId: U1, documentId: d.id, generation: d.g, run: 0 }, "done"); // no format
    const started: string[] = [];
    const afterDone = new Set<string>();
    const runtime = {
      cancel: async () => {},
      start: async (_f: unknown, _i: unknown, o: { executionId: string }) => {
        started.push(o.executionId);
        return {
          executionId: o.executionId,
          // The live event feed's end of a committed run: `done`, stamped with the current fingerprint.
          waitForCompletion: async () => {
            await runs.record(
              { userId: U1, documentId: d.id, generation: d.g, run: 1 },
              "done",
              undefined,
              factFormatFingerprint(),
            );
          },
        } as never;
      },
    };
    const starter = loomVisualsStarter(
      runtime as unknown as Pick<WorkflowRuntime, "start" | "cancel">,
      visualizeDocumentFlow(),
      {
        stale: pgStaleFormatDocuments(app),
        runs,
        afterDone,
      },
    );
    expect(await starter.sweep()).toBe(1);
    expect(started).toEqual([visualizeExecutionId(U1, d.id, d.g, 1)]); // a stale re-run is always `-r<n>`, n > 0
    expect(afterDone.size).toBe(1); // noted for the extract step: no extraction
    expect(await starter.sweep()).toBe(0);
    expect(started).toHaveLength(1);
  });

  it("the retry list leaves out a document whose generation moved on, a user being erased, and answers nothing to a null (STRICT)", async () => {
    await owner.query("DELETE FROM documents");
    const d = await readyDoc();
    await runs.record(
      { userId: U1, documentId: d.id, generation: d.g, run: 0 },
      "failed",
      "visuals-model-unavailable",
    );
    // A failure under an hour old is not retried at boot (a crash-looping process must not hammer a down model).
    expect(await pgRetryDocuments(app)(NIL, 10)).toEqual([]);
    await owner.query("UPDATE visual_runs SET updated_at = now() - interval '59 minutes'");
    expect(await pgRetryDocuments(app)(NIL, 10)).toEqual([]);
    await owner.query("UPDATE visual_runs SET updated_at = now() - interval '61 minutes'");
    expect(await pgRetryDocuments(app)(NIL, 10)).toHaveLength(1);
    expect(
      (await app.query("SELECT * FROM docmind_visual_retry_documents(NULL, 10)")).rows,
    ).toEqual([]);
    await owner.query(
      "UPDATE documents SET ingest_generation = ingest_generation + 1 WHERE id = $1",
      [d.id],
    );
    expect(await pgRetryDocuments(app)(NIL, 10)).toEqual([]); // the old generation's row is history (and the new one is not ready)
    await owner.query(
      "UPDATE documents SET ingest_generation = ingest_generation - 1 WHERE id = $1",
      [d.id],
    );
    expect(await pgRetryDocuments(app)(NIL, 10)).toHaveLength(1);
    await runs.record(
      { userId: U1, documentId: d.id, generation: d.g, run: 0 },
      "done",
      undefined,
      "old",
    );
    expect(await pgStaleFormatDocuments(app, "now")(NIL, 10)).toHaveLength(1);
    await owner.query("UPDATE users SET erasing_at = now() WHERE id = $1", [U1]); // final: last in this file
    expect(await pgRetryDocuments(app)(NIL, 10)).toEqual([]);
    expect(await pgStaleFormatDocuments(app, "now")(NIL, 10)).toEqual([]); // the stale-format list leaves out a user being erased too
  });

  it("records nothing for a user being erased (final: erasing_at cannot be undone)", async () => {
    const { id, g } = await readyDoc(BOB);
    await owner.query("UPDATE users SET erasing_at = now() WHERE id = $1", [U2]);
    await runs.record({ userId: U2, documentId: id, generation: g, run: 0 }, "failed");
    expect(await rowOf(id)).toEqual([]);
  });
});
