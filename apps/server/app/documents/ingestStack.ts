import { createSecretKey, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FakeOllama, startFakeOllama } from "@docmind/embeddings/testing";
import { PostgresKeyStore } from "@docmind/keystore-pg";
import { Pool } from "pg";
import { closeSequence } from "../closeSequence";
import { buildServer } from "../compose";
import { FieldCrypto } from "../crypto/fields";
import { migrate, setAppRolePassword, setRolePassword } from "../db/migrate";
import { APP_PASSWORD, LOOM_PASSWORD, type TestDb, createTestDb } from "../db/testSupport";
import { closeIngest, createIngestWiring } from "../flows/ingest-document/limits";
import { startRecovery } from "../flows/ingest-document/recovery";
import { verifyVectors } from "../flows/ingest-document/verifyVectors";
import { SHUTDOWN_DRAIN_MS, drainWithin, runAll } from "../shutdown";
import { bootStatus } from "../status/boot";
import { pgStatusReaderFor, pgStatusWriter } from "../status/pgStores";
import { type DurableStorage, openDurableStorage } from "../storage";
import { loadBlobRoot, loadLimits } from "./limits";
import { STALE_UPLOAD_MS, SWEEP_BATCH, SWEEP_LOOKBACK_MS } from "./sweep";
import { startSweeper } from "./sweeper";
import { openSse } from "./testHarness";

const PASSWORD = "correct horse battery";

export interface IngestEvent {
  documentId: string;
  step?: string;
  status: string;
  detail?: string;
}

export interface IngestStack {
  base: string;
  db: TestDb;
  app: Pool;
  keys: PostgresKeyStore;
  fields: FieldCrypto;
  durable: DurableStorage;
  fake: FakeOllama;
  composed: ReturnType<typeof buildServer>;
  root: string;
  signUpAndLogIn(email: string): Promise<{ cookie: string; userId: string; tenantId: string }>;
  upload(cookie: string, name: string, data: Uint8Array): Promise<Response>;
  events(cookie: string): ReturnType<typeof openSse>;
  /** Reads progress events until one satisfies `done`; returns every event of that document. */
  until(
    stream: Awaited<ReturnType<typeof openSse>>,
    documentId: string,
    done: (status: string) => boolean,
  ): Promise<IngestEvent[]>;
  /** Makes the next ingest start (an upload's or the sweep's) throw before it creates an execution. */
  failNextStart(): void;
  close(): Promise<void>;
}

/**
 * The production composition over real HTTP: real child-process parser, fake Ollama, Loom on durable
 * Postgres, the real chunks table and pgvector store, the two-role status stores. It boots in main's
 * order (verifyVectors, status boot, recovery, listen, sweeper) and closes in main's order.
 */
export async function startIngestStack(): Promise<IngestStack> {
  const db = await createTestDb();
  const cleanups: (() => Promise<unknown>)[] = [];
  try {
    await migrate(db.owner);
    await setAppRolePassword(db.owner, APP_PASSWORD);
    await setRolePassword(db.owner, "docmind_loom", LOOM_PASSWORD);
    const app = new Pool({ connectionString: db.appUrl });
    cleanups.unshift(() => app.end());
    const root = mkdtempSync(join(tmpdir(), "dm-ingest-e2e-"));
    cleanups.unshift(async () => rmSync(root, { recursive: true, force: true }));
    const keys = new PostgresKeyStore(app, [
      { id: "kek-1", key: createSecretKey(randomBytes(32)) },
    ]);
    const fields = new FieldCrypto(keys);
    const durable = await openDurableStorage({ loomUrl: db.loomUrl, keys });
    cleanups.unshift(() => durable.close());
    const fake = await startFakeOllama({ dimensions: 768, model: "fake-embed" }); // the migration fixes 768
    cleanups.unshift(() => fake.close());
    const wiring = createIngestWiring({
      DOCMIND_OLLAMA_URL: fake.url,
      DOCMIND_EMBED_MODEL: "fake-embed",
      DOCMIND_EMBED_DIMENSIONS: "768",
    });
    // The retry policy's backoff is the one timer a test must not wait on: attempts still run, back to back.
    wiring.sleep = async () => {};
    cleanups.unshift(() => closeIngest(wiring));
    let failStarts = 0;
    const composed = buildServer({
      wrapIngest: (port) => ({
        cancel: (identity, documentId, generation) => port.cancel(identity, documentId, generation),
        async start(identity, documentId, generation) {
          if (failStarts > 0) {
            failStarts--;
            throw new Error("synthetic-start-error");
          }
          return port.start(identity, documentId, generation);
        },
      }),
      pool: app,
      keys,
      storage: durable.storage,
      crypto: durable.crypto,
      limits: loadLimits({}),
      blobRoot: loadBlobRoot({ DOCMIND_BLOB_DIR: root }),
      secureCookies: false,
      trustProxy: false,
      ingest: wiring,
      status: {
        writer: pgStatusWriter(durable.pool),
        readerFor: pgStatusReaderFor(app),
        source: durable.storage.eventStore,
      },
      // no `vectors`: the production PgChunkVectorStore over the real chunks table
    });
    const { server, status, starts, events, vectors } = composed;
    cleanups.unshift(() => composed.app.close());

    // main's boot order: the schema must fit the embedder, then the status model registers and catches up.
    await verifyVectors(vectors, []);
    await bootStatus(status, []);
    const recovery = startRecovery(composed.app.runtime, durable.storage.eventStore, {
      ...(durable.storage.leaseStore && {
        leases: { store: durable.storage.leaseStore, owner: randomUUID() },
      }),
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const sweeper = startSweeper({
      pool: app,
      starts,
      status,
      olderThanMs: STALE_UPLOAD_MS,
      lookbackMs: SWEEP_LOOKBACK_MS,
      limit: SWEEP_BATCH,
    });

    async function signUpAndLogIn(email: string) {
      // The acceptance suite signs up more users from one address than the sign-up throttle allows.
      await db.owner.query("DELETE FROM auth_throttle");
      const post = (path: string) =>
        fetch(`${base}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email, password: PASSWORD }),
        });
      if ((await post("/api/auth/sign-up")).status !== 202)
        throw new Error("sign-up was not accepted");
      const login = await post("/api/auth/login");
      if (login.status !== 200) throw new Error("login was not accepted");
      const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
      const { rows } = await db.owner.query("SELECT id, tenant_id FROM users WHERE email = $1", [
        email,
      ]);
      return { cookie, userId: rows[0].id as string, tenantId: rows[0].tenant_id as string };
    }
    const upload = (cookie: string, name: string, data: Uint8Array) => {
      const form = new FormData();
      form.append("file", new Blob([data]), name);
      // No Origin and no Sec-Fetch-Site: what a non-browser client sends, which the origin guard accepts.
      return fetch(`${base}/api/documents`, { method: "POST", headers: { cookie }, body: form });
    };
    const openEvents = (cookie: string) => openSse(`${base}/api/documents/events`, { cookie });
    async function until(
      stream: Awaited<ReturnType<typeof openSse>>,
      id: string,
      done: (status: string) => boolean,
    ) {
      const seen: IngestEvent[] = [];
      for (;;) {
        const frame = await stream.next(); // rejects when the stream ends; the test's own timeout bounds a silent one
        const data = frame.split("\n").find((l) => l.startsWith("data: "));
        if (!data) continue; // the retry hint and heartbeats
        const event = JSON.parse(data.slice(6)) as IngestEvent;
        if (event.documentId !== id) continue;
        seen.push(event);
        if (done(event.status)) return seen;
      }
    }

    return {
      base,
      db,
      app,
      keys,
      fields,
      durable,
      fake,
      composed,
      root,
      signUpAndLogIn,
      upload,
      events: openEvents,
      until,
      failNextStart: () => {
        failStarts++;
      },
      async close() {
        // main's stop(): timers, then open streams, then the server drain, then the close sequence.
        recovery.stop();
        const sweeperStopped = sweeper.stop();
        events.closeAll();
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        });
        await drainWithin(sweeperStopped, SHUTDOWN_DRAIN_MS);
        const steps = closeSequence({
          startsIdle: () => starts.idle(),
          closeIngest: () => closeIngest(wiring),
          closeHeartbeat: () => composed.app.runtime.closeHeartbeat(),
          detachStatusFeed: composed.detachStatusFeed,
          closeStatus: () => status.close(),
          closeApp: () => composed.app.close(),
          closeDurable: () => durable.close(),
          endPool: () => app.end(),
        });
        await runAll(...steps, () => fake.close());
        await db.drop();
        rmSync(root, { recursive: true, force: true });
      },
    };
  } catch (err) {
    await runAll(...cleanups).catch(() => undefined);
    await db.drop().catch(() => undefined);
    throw err;
  }
}
