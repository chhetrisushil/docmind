import { createSecretKey, randomBytes } from "node:crypto";
import { PostgresKeyStore } from "@docmind/keystore-pg";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../config";
import { FieldCrypto } from "../crypto/fields";
import { migrate, setAppRolePassword, setRolePassword } from "../db/migrate";
import { withTenant } from "../db/tenant";
import { APP_PASSWORD, LOOM_PASSWORD, PG_URL, type TestDb, createTestDb } from "../db/testSupport";
import { pgIngestDeps } from "../flows/ingest-document/pgDeps";
import { type DurableStorage, createDurableStorage } from "../storage";
import { ingestExecutionId, loomIngest } from "./ingest";
import { insertDocument } from "./repo";
import { ALICE, T1, U1, newDocument, seedUsers } from "./testHarness";

describe.skipIf(!PG_URL)("ingest on durable storage (needs DOCMIND_TEST_PG_URL)", () => {
  let db: TestDb;
  let pool: Pool;
  let durable: DurableStorage;
  let fields: FieldCrypto;

  beforeAll(async () => {
    db = await createTestDb();
    await migrate(db.owner);
    await setAppRolePassword(db.owner, APP_PASSWORD);
    await setRolePassword(db.owner, "docmind_loom", LOOM_PASSWORD);
    await seedUsers(db.owner);
    pool = new Pool({ connectionString: db.appUrl });
    const keys = new PostgresKeyStore(pool, [
      { id: "kek-1", key: createSecretKey(randomBytes(32)) },
    ]);
    fields = new FieldCrypto(keys);
    durable = createDurableStorage({ loomUrl: db.loomUrl, keys });
  });
  afterAll(async () => {
    await durable?.close();
    await pool?.end();
    await db?.drop();
  });

  it("writes only ids and structural fields to the raw event log, never the document's text", async () => {
    const doc = await newDocument(fields, T1, U1, "d".repeat(64));
    await withTenant(pool, T1, (tx) => insertDocument(tx, doc));
    const app = buildApp(durable.storage, durable.crypto, { ingest: pgIngestDeps(pool) });
    const port = loomIngest(app.runtime);
    const handle = await port.start(ALICE, doc.id);
    expect((await handle?.waitForCompletion())?.status).toBe("completed");
    await app.close();

    const events = await durable.raw.eventStore.read(ingestExecutionId(U1, doc.id));
    expect(events.length).toBeGreaterThan(0);
    const raw = JSON.stringify(events);
    expect(raw).toContain(doc.id);
    expect(raw).toContain("accepted");
    // The document row holds "Quarterly report" / "Quarterly report.pdf" (sealed in the table).
    for (const text of ["Quarterly", "report", ".pdf", "application/pdf"]) {
      expect(raw).not.toContain(text);
    }
    // Every UUID in the log is one of the three ids.
    const uuids = new Set(
      raw.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g),
    );
    const known = new Set([T1, U1, doc.id]);
    const strangers = [...uuids].filter((u) => !known.has(u) && !events.some((e) => e.id === u));
    expect(strangers).toEqual([]);
  });
});
