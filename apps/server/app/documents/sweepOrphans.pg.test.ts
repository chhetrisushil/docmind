import { randomUUID } from "node:crypto";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryKeyStore } from "@loom/plugin-crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FieldCrypto } from "../crypto/fields";
import { migrate, setAppRolePassword, setRolePassword } from "../db/migrate";
import { APP_PASSWORD, LOOM_PASSWORD, PG_URL, type TestDb, createTestDb } from "../db/testSupport";
import { IngestStatus } from "../status/ingestStatus";
import { pgStatusReaderFor, pgStatusWriter } from "../status/pgStores";
import { ingestExecutionId } from "./ingest";
import { InMemoryProgressBus } from "./progress";
import { sweepOrphanStatuses } from "./sweep";
import { ALICE, U1, seedDoc, seedRow, seedUsers } from "./testHarness";

describe.skipIf(!PG_URL)("sweepOrphanStatuses (needs DOCMIND_TEST_PG_URL)", () => {
  let db: TestDb;
  let app: Pool;
  let loom: Pool;
  let status: IngestStatus;

  beforeAll(async () => {
    db = await createTestDb();
    await migrate(db.owner);
    await setAppRolePassword(db.owner, APP_PASSWORD);
    await setRolePassword(db.owner, "docmind_loom", LOOM_PASSWORD);
    await seedUsers(db.owner);
    app = new Pool({ connectionString: db.appUrl });
    loom = new Pool({ connectionString: db.loomUrl });
    status = new IngestStatus({
      writer: pgStatusWriter(loom),
      readerFor: pgStatusReaderFor(app),
      source: new InMemoryAsyncEventStore(),
      sensitive: {},
      bus: new InMemoryProgressBus(),
    });
    await status.boot();
  });
  afterAll(async () => {
    await status.close();
    await app.end();
    await loom.end();
    await db.drop();
  });

  it("tombstones the rows of deleted documents through the model, keeps live ones, and a second run finds nothing", async () => {
    const kept = await seedDoc(
      db.owner,
      app,
      new FieldCrypto(new InMemoryKeyStore()),
      ALICE,
      "9".repeat(64),
      600,
    );
    const gone = randomUUID();
    await seedRow(db.owner, ingestExecutionId(U1, kept), kept, U1);
    await seedRow(db.owner, ingestExecutionId(U1, gone), gone, U1);
    await seedRow(db.owner, ingestExecutionId(U1, gone, 1), gone, U1);
    expect(await sweepOrphanStatuses({ pool: app, status, limit: 10 })).toBe(2);
    const { rows } = await db.owner.query(
      "SELECT app_key, erased, state FROM read_model_state ORDER BY execution_id",
    );
    expect(rows.filter((r) => r.app_key === gone)).toEqual([
      { app_key: gone, erased: true, state: null },
      { app_key: gone, erased: true, state: null },
    ]);
    expect(rows.filter((r) => r.app_key === kept)).toEqual([
      { app_key: kept, erased: false, state: {} },
    ]);
    expect(await sweepOrphanStatuses({ pool: app, status, limit: 10 })).toBe(0);
  });

  it("logs a failure by class only and does not throw", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = {
      query: async () => {
        throw new RangeError("secret relation name");
      },
    } as unknown as Pool;
    expect(await sweepOrphanStatuses({ pool: broken, status, limit: 1 })).toBe(0);
    expect(spy).toHaveBeenCalledWith("orphan status sweep failed", "RangeError");
    expect(JSON.stringify(spy.mock.calls)).not.toContain("secret");
    spy.mockRestore();
  });
});
