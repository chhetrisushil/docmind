import { createSecretKey, randomBytes, randomUUID } from "node:crypto";
import { PostgresKeyStore } from "@docmind/keystore-pg";
import { ParseAbortedError } from "@docmind/parsers";
import type { LeaseStore } from "@loom/event-runtime";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../config";
import { migrate, setAppRolePassword, setRolePassword } from "../../db/migrate";
import {
  APP_PASSWORD,
  LOOM_PASSWORD,
  PG_URL,
  type TestDb,
  createTestDb,
} from "../../db/testSupport";
import { ingestExecutionId } from "../../documents/ingest";
import { foldIngestStatus } from "../../status/model";
import { openDurableStorage } from "../../storage";
import { ingestDocumentFlow } from "./flow";
import { type IngestWiring, closeIngest } from "./limits";
import { recoverIngest } from "./recovery";
import { fakeIngestDeps } from "./testing";

describe.skipIf(!PG_URL)("recovery over the real stores (needs DOCMIND_TEST_PG_URL)", () => {
  let db: TestDb;
  let pool: Pool;
  let keys: PostgresKeyStore;
  const open: (() => Promise<unknown>)[] = [];

  beforeAll(async () => {
    db = await createTestDb();
    await migrate(db.owner);
    await setAppRolePassword(db.owner, APP_PASSWORD);
    await setRolePassword(db.owner, "docmind_loom", LOOM_PASSWORD);
    pool = new Pool({ connectionString: db.appUrl });
    keys = new PostgresKeyStore(pool, [{ id: "kek-1", key: createSecretKey(randomBytes(32)) }]);
  });
  afterAll(async () => {
    for (const close of open.reverse()) await close().catch(() => {});
    await pool?.end();
    await db?.drop();
  });

  /** One process: its own Loom pool and app over the shared database, as after a restart. */
  async function boot(over: Parameters<typeof fakeIngestDeps>[0] = {}) {
    const durable = await openDurableStorage({ loomUrl: db.loomUrl, keys });
    const shutdown = new AbortController();
    const app = buildApp(durable.storage, durable.crypto, {
      ingest: fakeIngestDeps({ shutdown: shutdown.signal, sleep: async () => {}, ...over }),
    });
    open.push(
      () => durable.close(),
      () => app.close(),
    );
    return { durable, app, shutdown };
  }

  it("a live driver's lease vetoes recovery; the shutdown path releases it; the next boot then completes the step with no user action", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const ids = { tenantId: randomUUID(), userId: randomUUID(), documentId: randomUUID() };
    const executionId = ingestExecutionId(ids.userId, ids.documentId);

    // Process 1: a parse that is running when the shutdown comes. Like ParseRunner.close(), the runner aborts it.
    let inParse: () => void = () => {};
    const entered = new Promise<void>((resolve) => {
      inParse = resolve;
    });
    let abortParse: () => void = () => {};
    const runner = {
      run: async () => {
        inParse();
        await new Promise<never>((_, reject) => {
          abortParse = () => reject(new ParseAbortedError());
        });
        throw new Error("unreachable");
      },
      close: async () => abortParse(),
    };
    const one = await boot({ runner });
    const wiring = { shutdown: one.shutdown, runner } as unknown as IngestWiring;
    await one.app.runtime.start(ingestDocumentFlow, ids, {
      executionId,
      principal: { tenant: ids.tenantId, actor: ids.userId },
    });
    await entered;
    expect(await one.durable.lease.get?.(executionId)).not.toBeNull(); // heartbeat lease held while it runs

    // Process 2 boots while process 1 still drives: the lease is the evidence, so nothing is re-driven.
    const parsedFor: string[] = [];
    const two = await boot({
      parsed: {
        put: async (ref) => void parsedFor.push(ref.documentId),
        take: async () => ({ text: "", sections: [], media: [] }),
        has: async () => false,
        drop: async () => {},
      },
    });
    const source = two.durable.storage.eventStore;
    expect(await recoverIngest(two.app.runtime, source, { graceMs: 0 })).toMatchObject({
      candidates: 1,
      recovered: 0,
    });

    // The shutdown path of main.ts: interrupt the steps, then release the leases.
    await closeIngest(wiring);
    await one.app.runtime.closeHeartbeat();
    expect(await one.durable.lease.get?.(executionId)).toBeNull();

    // The lease expired nothing: it was released, so the very next pass recovers at once.
    expect(await recoverIngest(two.app.runtime, source, { graceMs: 0 })).toMatchObject({
      recovered: 1,
      failed: 0,
    });
    expect(parsedFor).toEqual([ids.documentId]);
    const all = await source.read(executionId);
    expect(all.map((e) => e.eventType)).not.toContain("EXECUTION_FAILED");
    expect(foldIngestStatus(all)).toMatchObject({ code: null });
    const state = await two.app.runtime.loadState(executionId, {
      principal: { tenant: ids.tenantId, actor: ids.userId },
    });
    expect([state?.status, state?.variables._output]).toEqual(["completed", { outcome: "done" }]);
  });

  it("a crashed process (leases never released) is recovered by a lease-mode pass once its lease expires; a live lease elsewhere is left alone", async () => {
    const mk = () => ({ tenantId: randomUUID(), userId: randomUUID(), documentId: randomUUID() });
    const [crashed, live] = [mk(), mk()];
    const idOf = (i: typeof crashed) => ingestExecutionId(i.userId, i.documentId);
    // Process 1 drives both and is then abandoned: no closeIngest, no closeHeartbeat.
    let inStep = 0;
    let bothIn: () => void = () => {};
    const entered = new Promise<void>((resolve) => {
      bothIn = resolve;
    });
    const one = await boot({
      guard: {
        begin: async () => {
          if (++inStep === 2) bothIn();
          await new Promise<never>(() => {});
        },
      },
    });
    for (const ids of [crashed, live]) {
      await one.app.runtime.start(ingestDocumentFlow, ids, {
        executionId: idOf(ids),
        principal: { tenant: ids.tenantId, actor: ids.userId },
      });
    }
    await entered;
    expect(await one.durable.lease.get?.(idOf(crashed))).not.toBeNull(); // the crash left its lease row
    // Its lease expires (the injected clock: the row's deadline moves into the past; no real wait).
    await db.owner.query("UPDATE loom.leases SET expires_at = 0 WHERE execution_id = $1", [
      idOf(crashed),
    ]);

    const two = await boot();
    const leases = { store: two.durable.storage.leaseStore as LeaseStore, owner: "node-2" };
    const summary = await recoverIngest(two.app.runtime, two.durable.storage.eventStore, {
      graceMs: 0,
      leases,
    });
    expect(summary).toMatchObject({ recovered: 1, failed: 0 });
    const state = await two.app.runtime.loadState(idOf(crashed), {
      principal: { tenant: crashed.tenantId, actor: crashed.userId },
    });
    expect(state?.status).toBe("completed");
    const liveTypes = (await two.durable.storage.eventStore.read(idOf(live))).map(
      (e) => e.eventType,
    );
    expect(liveTypes).not.toContain("EXECUTION_RECOVERED");
  });

  it("a full pass deletes an expired lease that has no stream (a ghost) and leaves a live lease untouched", async () => {
    const ghost = ingestExecutionId(randomUUID(), randomUUID());
    const live = ingestExecutionId(randomUUID(), randomUUID());
    const one = await boot();
    const store = one.durable.storage.leaseStore as LeaseStore;
    // A crash between taking the lease and the first append leaves rows with no stream.
    await store.acquire(ghost, "node-dead", 60_000);
    await store.acquire(live, "node-other", 3_600_000);
    await db.owner.query("UPDATE loom.leases SET expires_at = 0 WHERE execution_id = $1", [ghost]);
    expect(await store.get?.(ghost)).not.toBeNull();

    await recoverIngest(one.app.runtime, one.durable.storage.eventStore, { graceMs: 0 });

    expect(await store.get?.(ghost)).toBeNull();
    expect(await store.get?.(live)).not.toBeNull();
  });

  it("a full pass collects ghosts behind more than 100 expired orphans, and a lease-mode pass never runs the GC", async () => {
    const mk = () => ({ tenantId: randomUUID(), userId: randomUUID(), documentId: randomUUID() });
    // Process 1 starts 105 executions and hangs in each: real streams, so their expired leases are orphans.
    const one = await boot({ guard: { begin: () => new Promise<never>(() => {}) } });
    const orphans: string[] = [];
    for (let i = 0; i < 105; i++) {
      const ids = mk();
      const executionId = ingestExecutionId(ids.userId, ids.documentId);
      orphans.push(executionId);
      await one.app.runtime.start(ingestDocumentFlow, ids, {
        executionId,
        principal: { tenant: ids.tenantId, actor: ids.userId },
      });
    }
    const ghosts = [
      ingestExecutionId(randomUUID(), randomUUID()),
      ingestExecutionId(randomUUID(), randomUUID()),
    ];
    const two = await boot();
    const store = two.durable.storage.leaseStore as LeaseStore;
    for (const g of ghosts) await store.acquire(g, "node-dead", 60_000);
    // Soonest-expired first: the orphans fill the first 100-row window, the ghosts sit behind it.
    await db.owner.query("UPDATE loom.leases SET expires_at = 1 WHERE execution_id = ANY($1)", [
      orphans,
    ]);
    await db.owner.query("UPDATE loom.leases SET expires_at = 2 WHERE execution_id = ANY($1)", [
      ghosts,
    ]);
    const source = two.durable.storage.eventStore;
    const idle = { graceMs: 3_600_000_000 }; // nothing is re-driven: only the GC is under test

    await recoverIngest(two.app.runtime, source, {
      ...idle,
      leases: { store, owner: "node-2" },
    });
    for (const g of ghosts) expect(await store.get?.(g)).not.toBeNull(); // lease mode leaves them

    await recoverIngest(two.app.runtime, source, idle);
    for (const g of ghosts) expect(await store.get?.(g)).toBeNull();
    for (const o of orphans.slice(0, 3)) expect(await store.get?.(o)).not.toBeNull(); // orphans stay
  }, 60_000);
});
