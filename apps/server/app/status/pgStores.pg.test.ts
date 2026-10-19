import { randomUUID } from "node:crypto";
import { foldedStates } from "@loom/plugin-read-model";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, setAppRolePassword, setRolePassword } from "../db/migrate";
import { APP_PASSWORD, LOOM_PASSWORD, PG_URL, type TestDb, createTestDb } from "../db/testSupport";
import { InMemoryProgressBus } from "../documents/progress";
import { ALICE, ALICE2, BOB, T1, U1, U1B, U2, seedUsers } from "../documents/testHarness";
import { IngestStatus } from "./ingestStatus";
import { INGEST_STATUS_MODEL } from "./model";
import { pgStatusReaderFor, pgStatusWriter } from "./pgStores";
import { MemoryLog, ingestRun } from "./testing";

describe.skipIf(!PG_URL)(
  "IngestStatus over Postgres with the real roles (needs DOCMIND_TEST_PG_URL)",
  () => {
    let db: TestDb;
    let app: Pool;
    let loom: Pool;
    let status: IngestStatus;
    const [D1, D2, D3] = [randomUUID(), randomUUID(), randomUUID()];
    const exec = (user: string, doc: string) => `u_${user}:ingest-${doc}`;
    const statements: string[] = [];
    const D4 = randomUUID();

    beforeAll(async () => {
      db = await createTestDb();
      await migrate(db.owner);
      await setAppRolePassword(db.owner, APP_PASSWORD);
      await setRolePassword(db.owner, "docmind_loom", LOOM_PASSWORD);
      await seedUsers(db.owner);
      app = new Pool({ connectionString: db.appUrl });
      loom = new Pool({ connectionString: db.loomUrl });
      // withTenant runs every reader statement on a pooled client, so record what each client sends.
      const connect = app.connect.bind(app) as () => Promise<PoolClient>;
      (app as { connect: unknown }).connect = async () => {
        const client = await connect();
        const query = client.query.bind(client) as (...a: unknown[]) => unknown;
        (client as { query: unknown }).query = (...a: unknown[]) => {
          if (typeof a[0] === "string") statements.push(a[0]);
          return query(...a);
        };
        return client;
      };
      const log = new MemoryLog();
      log.append(
        ...ingestRun(exec(U1, D1), "parsed"),
        ...ingestRun(exec(U1B, D2), "parsed"),
        ...ingestRun(exec(U2, D3), "parsed"),
        ...ingestRun(exec(U1, D4), "parsed"),
        ...ingestRun(exec(U2, D1), "parsed"), // another tenant's row under the same key as D1
        ...ingestRun(`u_${U1}:chat-1`, "started"), // another flow: no key, no scope
      );
      status = new IngestStatus({
        writer: pgStatusWriter(loom),
        readerFor: pgStatusReaderFor(app),
        source: log,
        sensitive: {},
        bus: new InMemoryProgressBus(),
      });
      await status.boot();
    });
    afterAll(async () => {
      await app?.end();
      await loom?.end();
      await db?.drop();
    });

    it("forPage returns only the caller's own documents, end to end, and never runs DDL on the app role's connections", async () => {
      expect([...(await status.forPage(ALICE, [D1, D2, D3])).keys()]).toEqual([D1]);
      expect([...(await status.forPage(ALICE2, [D1, D2, D3])).keys()]).toEqual([D2]);
      expect([...(await status.forPage(BOB, [D1, D2, D3])).keys()].sort()).toEqual([D1, D3].sort());
      expect((await status.forPage(ALICE, [D1])).get(D1)?.status).toBe("parsing");
      expect(statements.some((q) => /read_model_state/.test(q))).toBe(true); // the spy sees the reads
      expect(statements.filter((q) => /^\s*(CREATE|ALTER|DROP)/i.test(q))).toEqual([]);
    });

    it("the reader sees only its tenant's folded rows, and cannot write (the app role holds no write privilege)", async () => {
      const reader = pgStatusReaderFor(app)({ tenantId: T1 });
      const rows = foldedStates(
        (await reader.getFoldedByKey?.(INGEST_STATUS_MODEL, [D1, D2, D3])) ?? [],
      );
      expect(rows.map((r) => r.key).sort()).toEqual([D1, D2].sort());
      await expect(
        reader.applyFolded?.({
          modelId: INGEST_STATUS_MODEL,
          executionId: exec(U1, D1),
          upToSequence: 99,
          state: {},
          key: D1,
          scope: U1,
          foldVersion: "1",
        }),
      ).rejects.toThrow(/permission denied/);
    });

    it("keeps another flow's row out of every tenant's reads", async () => {
      const { rows } = await db.owner.query(
        "SELECT app_key, scope FROM read_model_state WHERE execution_id = $1",
        [`u_${U1}:chat-1`],
      );
      expect(rows).toEqual([{ app_key: null, scope: null }]);
      const reader = pgStatusReaderFor(app)({ tenantId: T1 });
      const seen = foldedStates((await reader.getFoldedByKey?.(INGEST_STATUS_MODEL, [D1])) ?? []);
      expect(seen.every((r) => r.key === D1)).toBe(true);
    });

    it("forgetDocument tombstones only the caller's row for a shared key, and a later event cannot revive it", async () => {
      await status.forgetDocument(ALICE, D1);
      expect((await status.forPage(ALICE, [D1])).size).toBe(0);
      expect((await status.forPage(BOB, [D1])).get(D1)?.status).toBe("parsing"); // same key, other tenant
      expect((await status.forPage(ALICE, [D4])).size).toBe(1);
      const row = () =>
        db.owner.query(
          "SELECT erased, state, scope, sequence FROM read_model_state WHERE execution_id = $1",
          [exec(U1, D1)],
        );
      const before = (await row()).rows[0];
      expect(before).toMatchObject({ erased: true, state: null, scope: U1 });
      const log = new MemoryLog();
      log.append(...ingestRun(exec(U1, D1), "failed:too_large"));
      for (const e of log.events()) status.onEvent(e);
      await status.close();
      const after = (await row()).rows[0];
      expect(after).toMatchObject({ erased: true, state: null });
      expect(Number(after.sequence)).toBeGreaterThan(Number(before.sequence));
      expect((await status.forPage(ALICE, [D1])).size).toBe(0);
    });

    it("forgetUser tombstones one user's rows and leaves another user of the same tenant and other tenants alone", async () => {
      expect(await status.forgetUser(U1)).toBe(1); // D4 (D1 is already erased); the chat row has no scope
      expect((await status.forPage(ALICE, [D4])).size).toBe(0);
      expect((await status.forPage(ALICE2, [D2])).size).toBe(1);
      expect((await status.forPage(BOB, [D3])).size).toBe(1);
    });
  },
);
