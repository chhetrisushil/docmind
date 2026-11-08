import { InMemoryKeyStore } from "@loom/plugin-crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FieldCrypto } from "../../crypto/fields";
import { migrate, setAppRolePassword } from "../../db/migrate";
import { APP_PASSWORD, PG_URL, type TestDb, createTestDb } from "../../db/testSupport";
import { ingestExecutionId } from "../../documents/ingest";
import { ALICE, BOB, U1, U2, seedDoc, seedRow, seedUsers } from "../../documents/testHarness";
import { PgVisualRuns } from "./runs";
import { pgReadyDocuments, pgRetryDocuments } from "./start";

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

  it("the retry list leaves out a document whose generation moved on, a user being erased, and answers nothing to a null (STRICT)", async () => {
    await owner.query("DELETE FROM documents");
    const d = await readyDoc();
    await runs.record(
      { userId: U1, documentId: d.id, generation: d.g, run: 0 },
      "failed",
      "visuals-model-unavailable",
    );
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
    await owner.query("UPDATE users SET erasing_at = now() WHERE id = $1", [U1]); // final: last in this file
    expect(await pgRetryDocuments(app)(NIL, 10)).toEqual([]);
  });
});
