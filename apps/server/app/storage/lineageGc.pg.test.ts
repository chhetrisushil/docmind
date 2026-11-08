import { createSecretKey, randomBytes, randomUUID } from "node:crypto";
import { PostgresKeyStore } from "@docmind/keystore-pg";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, setAppRolePassword, setRolePassword } from "../db/migrate";
import { pgSessionLock } from "../db/sessionLock";
import { APP_PASSWORD, LOOM_PASSWORD, PG_URL, type TestDb, createTestDb } from "../db/testSupport";
import {
  commitPlan,
  commitPlanTo,
  experienceIdOf,
  visualsLineage,
} from "../flows/visualize-document/lineage";
import { aPlan } from "../flows/visualize-document/testing";
import { turnExperienceId } from "../flows/visualize-turn/ids";
import { TURN_INTENT } from "../flows/visualize-turn/plan";
import { type DurableStorage, createDurableStorage, sealedLineageContent } from "../storage";
import { subjectOfExecution } from "../subject";
import { collectLineageContent } from "./lineageGc";
import { PgContentStore } from "./pgContentStore";
import { lineageGcDeps } from "./pgLineageGc";

const DAY = 86_400_000;
const NOW = "2026-11-08T10:00:00.000Z";
const enc = (s: string) => new TextEncoder().encode(s);

describe.skipIf(!PG_URL)("lineage content collector (needs DOCMIND_TEST_PG_URL)", () => {
  let db: TestDb;
  let app: Pool;
  let keys: PostgresKeyStore;
  let stores: DurableStorage;
  let clock = 1_700_000_000_000;
  let inner: PgContentStore;
  let lineage: ReturnType<typeof visualsLineage>;

  beforeAll(async () => {
    db = await createTestDb();
    await migrate(db.owner);
    await setAppRolePassword(db.owner, APP_PASSWORD);
    await setRolePassword(db.owner, "docmind_loom", LOOM_PASSWORD);
    app = new Pool({ connectionString: db.appUrl });
    keys = new PostgresKeyStore(app, [{ id: "kek-1", key: createSecretKey(randomBytes(32)) }]);
    stores = createDurableStorage({ loomUrl: db.loomUrl, keys });
    // The store's clock is the test's: touch times (and so the grace) are deterministic.
    inner = new PgContentStore(app, { now: () => clock });
    lineage = visualsLineage({
      events: stores.sealed.eventStore,
      content: sealedLineageContent(inner, keys),
      keys,
      subjectOf: subjectOfExecution,
    });
  });

  afterAll(async () => {
    await stores?.storage.eventStore.close?.();
    await stores?.close();
    await app?.end();
    await db?.drop();
  });

  const refOf = (userId: string) => ({ tenantId: randomUUID(), userId, documentId: randomUUID() });
  const addressesOf = async (experienceId: string) => {
    const state = await lineage.state(experienceId);
    if (!state.ok) throw new Error("no state");
    return [...state.value.versions.values()].map(
      (v) => (v.ref as { __loomContent: string }).__loomContent,
    );
  };
  const exists = async (address: string) => (await inner.get({ __loomContent: address })) !== null;
  const run = (over: Parameters<typeof lineageGcDeps>[0] = { lineage, store: inner }) =>
    collectLineageContent(lineageGcDeps(over, stores.pool));
  /** A document line with two versions (so more than one blob). */
  async function twoVersions(userId: string, label: string) {
    const r = refOf(userId);
    await commitPlan(lineage, r, await aPlan("n1", label), () => NOW);
    await commitPlan(lineage, r, await aPlan("n2", `${label}-2`), () => NOW);
    return { r, id: experienceIdOf(r) };
  }

  it("keeps live document and chat-turn lines, reclaims an erased user's blobs and an orphan, and a repeat is idempotent", async () => {
    const live = await twoVersions(randomUUID(), "Live-Label");
    const liveAddresses = await addressesOf(live.id);
    expect(liveAddresses.length).toBeGreaterThanOrEqual(2);

    const turnUser = randomUUID();
    const turn = { userId: turnUser, chatId: randomUUID(), ord: 3 };
    const turnId = turnExperienceId(turn);
    await commitPlanTo(
      lineage,
      { experienceId: turnId, intent: TURN_INTENT, sourceKind: "turn-visuals" },
      await aPlan("t1", "Turn-Label"),
      () => NOW,
    );
    const turnAddresses = await addressesOf(turnId);

    const erasedUser = randomUUID();
    const erased = await twoVersions(erasedUser, "Erased-Label");
    const erasedAddresses = await addressesOf(erased.id);
    await keys.destroy(erasedUser);

    const orphan = (await inner.put(enc(`orphan-${randomUUID()}`))).__loomContent;

    clock += 3 * DAY;
    const report = await run();
    expect(report.refused).toBeUndefined();
    expect(report).toMatchObject({ failed: 0, skipped: false });
    expect(report.reclaimed).toBe(erasedAddresses.length + 1);

    for (const a of [...liveAddresses, ...turnAddresses]) expect(await exists(a), a).toBe(true);
    for (const a of [...erasedAddresses, orphan]) expect(await exists(a), a).toBe(false);
    // The live lines still open after the sweep.
    const head = await lineage.resolveLatest(live.id);
    expect(head.ok && JSON.stringify(head.value)).toContain("Live-Label");
    const turnHead = await lineage.resolveLatest(turnId);
    expect(turnHead.ok && JSON.stringify(turnHead.value)).toContain("Turn-Label");

    expect((await run()).reclaimed).toBe(0);
  });

  it("keeps a blob that is touched after the roots were computed, and one younger than the grace", async () => {
    const live = await twoVersions(randomUUID(), "Race-Label");
    const old = (await inner.put(enc(`old-${randomUUID()}`))).__loomContent;
    const raced = (await inner.put(enc(`raced-${randomUUID()}`))).__loomContent;
    clock += 3 * DAY;
    const young = (await inner.put(enc(`young-${randomUUID()}`))).__loomContent;
    const deps = lineageGcDeps({ lineage, store: inner }, stores.pool);
    const report = await collectLineageContent({
      ...deps,
      pins: async function* () {
        yield* lineage.pins({ keepLast: Number.POSITIVE_INFINITY });
        // A writer re-cites an old blob (a put or a touch) while the run is between roots and sweep.
        await inner.touch([raced]);
      },
    });
    expect(report.refused).toBeUndefined();
    expect(await exists(old)).toBe(false);
    expect(await exists(raced)).toBe(true);
    expect(await exists(young)).toBe(true);
    for (const a of await addressesOf(live.id)) expect(await exists(a)).toBe(true);
  });

  it("deletes nothing when one line cannot be read", async () => {
    const good = await twoVersions(randomUUID(), "Good-Label");
    const bad = await twoVersions(randomUUID(), "Bad-Label");
    const orphan = (await inner.put(enc(`orphan-${randomUUID()}`))).__loomContent;
    const badStream = `__loom_ui_lineage__:${bad.id}`;
    const events = new Proxy(stores.sealed.eventStore, {
      get(target, key) {
        if (key === "read")
          return async (id: string, ...rest: unknown[]) => {
            if (id === badStream) throw new Error("the store is down");
            return (target.read as (...a: unknown[]) => Promise<unknown>).call(target, id, ...rest);
          };
        const v = Reflect.get(target, key);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const flaky = visualsLineage({
      events,
      content: sealedLineageContent(inner, keys),
      keys,
      subjectOf: subjectOfExecution,
    });
    const goodAddresses = await addressesOf(good.id);
    clock += 3 * DAY;
    const { count: before } = (
      await app.query("SELECT count(*)::int AS count FROM lineage_content")
    ).rows[0];
    const report = await run({ lineage: flaky, store: inner });
    expect(report).toMatchObject({ refused: "roots-incomplete", reclaimed: 0, failed: 1 });
    expect(
      (await app.query("SELECT count(*)::int AS count FROM lineage_content")).rows[0].count,
    ).toBe(before);
    expect(await exists(orphan)).toBe(true);
    for (const a of goodAddresses) expect(await exists(a)).toBe(true);
  });

  it("lets one of two concurrent runs work and the other skip (cross-replica lock)", async () => {
    await twoVersions(randomUUID(), "Lock-Label");
    clock += 3 * DAY;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const deps = lineageGcDeps({ lineage, store: inner }, stores.pool);
    const first = collectLineageContent({
      ...deps,
      pins: async function* () {
        await gate;
        yield* lineage.pins({ keepLast: Number.POSITIVE_INFINITY });
      },
    });
    // The first holds the lock once it is inside pins; poll until a second run is refused it.
    let second = await collectLineageContent(deps);
    for (let i = 0; i < 50 && !second.skipped; i++) {
      await new Promise((r) => setTimeout(r, 20));
      second = await collectLineageContent(deps);
    }
    expect(second).toMatchObject({ skipped: true, reclaimed: 0 });
    release();
    const done = await first;
    expect(done.skipped).toBe(false);
    // The lock is free again.
    const lock = await pgSessionLock(stores.pool, "docmind:lineage-gc", "test");
    expect(lock).not.toBeNull();
    await lock?.();
  });
});
