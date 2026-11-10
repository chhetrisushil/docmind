import { createSecretKey, randomBytes, randomUUID } from "node:crypto";
import { PostgresKeyStore } from "@docmind/keystore-pg";
import { LINEAGE_STREAM_PREFIX, LINEAGE_WORKFLOW_ID } from "@loom-ui/lineage";
import type { EventEnvelope } from "@loom/core";
import { isKeyUnavailable, isPayloadShredded } from "@loom/event-runtime";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, setAppRolePassword, setRolePassword } from "../../db/migrate";
import {
  APP_PASSWORD,
  LOOM_PASSWORD,
  PG_URL,
  type TestDb,
  createTestDb,
} from "../../db/testSupport";
import { InMemoryProgressBus } from "../../documents/progress";
import { type DurableStorage, createDurableStorage, sealedLineageContent } from "../../storage";
import { PgContentStore } from "../../storage/pgContentStore";
import { subjectOfExecution } from "../../subject";
import { type CommitInput, commitEffect } from "./commit";
import { commitPlan, visualsLineage } from "./lineage";
import { experienceIdOf, lineageTestIds } from "./testSupport";
import { aPlan } from "./testing";

const SECRET_LABEL = "Zebra-Secret-Label";
const SECRET_SUMMARY = "Zebra-Secret-Summary";
const NOW = "2026-11-08T10:00:00.000Z";

describe.skipIf(!PG_URL)("visuals lineage erasure (needs DOCMIND_TEST_PG_URL)", () => {
  let db: TestDb;
  let app: Pool;
  let keys: PostgresKeyStore;
  let stores: DurableStorage;
  let inner: PgContentStore;
  let lineage: ReturnType<typeof visualsLineage>;

  beforeAll(async () => {
    db = await createTestDb();
    await migrate(db.owner);
    await setAppRolePassword(db.owner, APP_PASSWORD);
    await setRolePassword(db.owner, "docmind_loom", LOOM_PASSWORD);
    app = new Pool({ connectionString: db.appUrl });
    keys = new PostgresKeyStore(app, [{ id: "kek-1", key: createSecretKey(randomBytes(32)) }]);
    // The real storage wiring: the encrypting event store with the lineage paths registered.
    stores = createDurableStorage({ loomUrl: db.loomUrl, keys });
    inner = new PgContentStore(app);
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
  const streamOf = async (r: ReturnType<typeof refOf>) =>
    `${LINEAGE_STREAM_PREFIX}${await experienceIdOf(r)}`;

  it("seals the line under the user's key, and destroying the key erases events and blobs", async () => {
    const u1 = randomUUID();
    const u2 = randomUUID();
    const r1 = refOf(u1);
    const r2 = refOf(u2);
    const plan = await aPlan("revenue", SECRET_LABEL, SECRET_SUMMARY);
    await commitPlan(lineage, lineageTestIds, r1, plan, () => NOW);
    await commitPlan(lineage, lineageTestIds, r2, await aPlan("other", "Other-Label"), () => NOW);

    // 1. It reads back while the key exists.
    const before = await lineage.resolveLatest(await experienceIdOf(r1));
    expect(before.ok && JSON.stringify(before.value)).toContain(SECRET_LABEL);

    // 2. Raw events and raw blobs hold no secret.
    const rawEvents = await stores.raw.eventStore.read(await streamOf(r1));
    expect(rawEvents.length).toBeGreaterThanOrEqual(2);
    const rawJson = JSON.stringify(rawEvents);
    for (const secret of [SECRET_LABEL, SECRET_SUMMARY, "KeyFigure", "fact-0"])
      expect(rawJson, secret).not.toContain(secret);
    const state = await lineage.state(await experienceIdOf(r1));
    if (!state.ok) throw new Error("no state");
    const refs = [...state.value.versions.values()].map((v) => v.ref);
    expect(refs.length).toBeGreaterThanOrEqual(2);
    for (const ref of refs) {
      const bytes = await inner.get(ref as never);
      expect(bytes).not.toBeNull();
      expect(new TextDecoder("latin1").decode(bytes as Uint8Array)).not.toContain("KeyFigure");
      expect(new TextDecoder("latin1").decode(bytes as Uint8Array)).not.toContain(SECRET_LABEL);
    }

    // 3. Destroy the user's key (this user has no executions, so no shred is owed).
    await keys.destroy(u1);
    await keys.destroy(subjectOfExecution({ executionId: await streamOf(r1) })); // the new-format line is owned by the handle's subject `h_<H>`
    const after = await lineage.resolveLatest(await experienceIdOf(r1));
    expect(after).toMatchObject({
      ok: false,
      refusal: { kind: "refused", finding: { code: "line-erased" } },
    });
    // The blob rows outlive the key (only ciphertext remains), but nothing can open them.
    for (const ref of refs) expect(await inner.get(ref as never)).not.toBeNull();
    const sealedContent = sealedLineageContent(inner, keys);
    const access = { executionId: await streamOf(r1), workflowId: LINEAGE_WORKFLOW_ID };
    const opened = await sealedContent.get(refs[0] as never, access).then(
      () => undefined,
      (err: unknown) => err,
    );
    // A recorded destruction reads as shredded; both are the "cannot open" class of loom.
    expect(isKeyUnavailable(opened) || isPayloadShredded(opened)).toBe(true);

    // A write to the erased line is refused, and the commit step reports the document gone.
    const input: CommitInput = {
      ...r1,
      ops: [...plan.ops],
      report: plan.report,
    };
    const effect = commitEffect({
      guard: { begin: async () => {} },
      lineage,
      ids: lineageTestIds,
      bus: new InMemoryProgressBus(),
      now: () => NOW,
    });
    expect(await effect.execute(input, undefined as never)).toEqual({ outcome: "document_gone" });

    // Another user's line is untouched.
    const other = await lineage.resolveLatest(await experienceIdOf(r2));
    expect(other.ok && JSON.stringify(other.value)).toContain("Other-Label");
  });

  it("refuses a write to any other lineage stream (no subject)", async () => {
    const event = {
      id: randomUUID(),
      workflowId: LINEAGE_WORKFLOW_ID,
      executionId: `${LINEAGE_STREAM_PREFIX}foo`,
      eventType: "EXPERIENCE_COMPOSED",
      sequence: 1,
      timestamp: 1,
      payload: { ops: [], by: {} },
    } as unknown as EventEnvelope;
    await expect(stores.sealed.eventStore.append(event)).rejects.toThrow(/resolved to ""/);
    await expect(
      sealedLineageContent(inner, keys).put(new Uint8Array([1, 2, 3]), {
        executionId: `${LINEAGE_STREAM_PREFIX}foo`,
        workflowId: LINEAGE_WORKFLOW_ID,
      }),
    ).rejects.toThrow(/resolved to ""/);
    expect(await stores.raw.eventStore.read(`${LINEAGE_STREAM_PREFIX}foo`)).toEqual([]);
  });
});
