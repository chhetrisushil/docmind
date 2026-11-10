import { createSecretKey, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PostgresKeyStore } from "@docmind/keystore-pg";
import { LINEAGE_STREAM_PREFIX, LINEAGE_WORKFLOW_ID } from "@loom-ui/lineage";
import { runContentStoreConformance } from "@loom/conformance";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { EncryptingEventStore } from "@loom/plugin-crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../compose";
import { migrate, setAppRolePassword } from "../db/migrate";
import { APP_PASSWORD, PG_URL, type TestDb, createTestDb } from "../db/testSupport";
import { loadBlobRoot, loadLimits } from "../documents/limits";
import { createIngestWiring } from "../flows/ingest-document/limits";
import { commitPlan, visualsLineage } from "../flows/visualize-document/lineage";
import { experienceIdOf, lineageTestIds } from "../flows/visualize-document/testSupport";
import { aPlan } from "../flows/visualize-document/testing";
import { SENSITIVE_EVENT_PATHS } from "../sensitive";
import { sealedLineageContent } from "../storage";
import { subjectOfExecution } from "../subject";
import { PgContentStore } from "./pgContentStore";

const SECRET_LABEL = "Zebra-Secret-Label";
const NOW = "2026-11-08T10:00:00.000Z";
const enc = (s: string) => new TextEncoder().encode(s);

describe.skipIf(!PG_URL)("PgContentStore (needs DOCMIND_TEST_PG_URL)", () => {
  let db: TestDb;
  let app: Pool;
  let keys: PostgresKeyStore;
  const root = mkdtempSync(join(tmpdir(), "dm-lineage-content-"));

  beforeAll(async () => {
    db = await createTestDb();
    await migrate(db.owner);
    await setAppRolePassword(db.owner, APP_PASSWORD);
    app = new Pool({ connectionString: db.appUrl });
    keys = new PostgresKeyStore(app, [{ id: "kek-1", key: createSecretKey(randomBytes(32)) }]);
  });

  afterAll(async () => {
    await app?.end();
    await db?.drop();
    rmSync(root, { recursive: true, force: true });
  });

  // The loom conformance kit, run against the plain store and against the sealed store over it.
  runContentStoreConformance(() => new PgContentStore(app), "PgContentStore", {
    clocked: (now) => new PgContentStore(app, { now }),
  });
  runContentStoreConformance(
    () => sealedLineageContent(new PgContentStore(app), keys),
    "sealed PgContentStore",
    {
      clocked: (now) => sealedLineageContent(new PgContentStore(app, { now }), keys),
      access: {
        executionId: `${LINEAGE_STREAM_PREFIX}visuals-${randomUUID()}-${randomUUID()}`,
        workflowId: LINEAGE_WORKFLOW_ID,
      },
    },
  );

  it("keeps one row per content address and the bytes as given", async () => {
    const store = new PgContentStore(app);
    const ref = await store.put(enc("one row"));
    await store.put(enc("one row"));
    const { rows } = await db.owner.query("SELECT bytes FROM lineage_content WHERE address = $1", [
      ref.__loomContent,
    ]);
    expect(rows).toHaveLength(1);
    expect(Buffer.from(rows[0].bytes).toString()).toBe("one row");
    expect(ref.size).toBe(7);
  });

  it("pages in address order and honours touchedBefore", async () => {
    let clock = 1_000;
    const store = new PgContentStore(app, { now: () => clock });
    const a = await store.put(enc("page-a"));
    clock = 5_000;
    const b = await store.put(enc("page-b"));
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await store.listPage({ limit: 2, ...(cursor && { cursor }) });
      seen.push(...page.entries.map((e) => e.address));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual([...seen].sort());
    expect(seen).toEqual(expect.arrayContaining([a.__loomContent, b.__loomContent]));
    const old = await store.listPage({ touchedBefore: 2_000 });
    expect(old.entries.map((e) => e.address)).toContain(a.__loomContent);
    expect(old.entries.map((e) => e.address)).not.toContain(b.__loomContent);
    await expect(store.listPage({ limit: 0 })).rejects.toThrow(RangeError);
  });

  it("composition: lineage writes land in lineage_content as ciphertext, and erasing the key keeps the row but closes it", async () => {
    const events = new EncryptingEventStore(new InMemoryAsyncEventStore(), keys, {
      sensitive: { ...SENSITIVE_EVENT_PATHS },
      subjectOf: subjectOfExecution,
    });
    const composed = buildServer({
      pool: app,
      keys,
      storage: { kind: "custom", eventStore: events },
      crypto: { events },
      limits: loadLimits({}),
      blobRoot: loadBlobRoot({ DOCMIND_BLOB_DIR: root }),
      secureCookies: false,
      trustProxy: false,
      ingest: createIngestWiring({ DOCMIND_LLM_PROVIDER: "off" }),
      status: { writer: {} as never, readerFor: () => ({}) as never, source: events },
    });
    try {
      // Production lineage content is the sealed store.
      expect(composed.lineageContent.sealsContent).toBe(true);
      const lineage = visualsLineage({
        events,
        content: composed.lineageContent,
        keys,
        subjectOf: subjectOfExecution,
      });
      const ref = { tenantId: randomUUID(), userId: randomUUID(), documentId: randomUUID() };
      await commitPlan(
        lineage,
        lineageTestIds,
        ref,
        await aPlan("revenue", SECRET_LABEL, "Zebra-Secret-Summary"),
        () => NOW,
      );
      const before = await lineage.resolveLatest(await experienceIdOf(ref));
      expect(before.ok && JSON.stringify(before.value)).toContain(SECRET_LABEL);

      const state = await lineage.state(await experienceIdOf(ref));
      if (!state.ok) throw new Error("no state");
      const addresses = [...state.value.versions.values()].map(
        (v) => (v.ref as { __loomContent: string }).__loomContent,
      );
      expect(addresses.length).toBeGreaterThanOrEqual(1);
      for (const address of addresses) {
        const { rows } = await db.owner.query(
          "SELECT bytes FROM lineage_content WHERE address = $1",
          [address],
        );
        expect(rows).toHaveLength(1);
        const raw = Buffer.from(rows[0].bytes).toString("latin1");
        expect(raw).not.toContain(SECRET_LABEL);
        expect(raw).not.toContain("KeyFigure");
      }

      // Erase: destroy the key. The blob rows stay, and nothing opens them.
      await keys.destroy(ref.userId);
      await keys.destroy(
        subjectOfExecution({ executionId: `${LINEAGE_STREAM_PREFIX}${await experienceIdOf(ref)}` }),
      ); // the new-format line's owner is the handle's subject
      const { rows: left } = await db.owner.query(
        "SELECT count(*)::int AS n FROM lineage_content WHERE address = ANY($1::text[])",
        [addresses],
      );
      expect(left[0].n).toBe(addresses.length);
      await expect(
        composed.lineageContent.get(
          { __loomContent: addresses[0] as string },
          {
            executionId: `${LINEAGE_STREAM_PREFIX}${await experienceIdOf(ref)}`,
            workflowId: LINEAGE_WORKFLOW_ID,
          },
        ),
      ).rejects.toThrow();
      expect(await lineage.resolveLatest(await experienceIdOf(ref))).toMatchObject({
        ok: false,
        refusal: { kind: "refused", finding: { code: "line-erased" } },
      });
    } finally {
      await composed.readiness.close();
      await composed.app.close();
    }
  });
});
