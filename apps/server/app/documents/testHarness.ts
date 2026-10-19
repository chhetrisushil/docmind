import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Authenticator, Identity } from "@docmind/auth";
import { EncryptedFsContentStore, deriveFingerprintKey, fingerprintOf } from "@docmind/blob-store";
import { startFakeOllama } from "@docmind/embeddings/testing";
import { type ChunkVectorStore, InMemoryChunkVectors, type VectorScope } from "@docmind/vector-pg";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryKeyStore } from "@loom/plugin-crypto";
import { InMemoryReadModelStore } from "@loom/plugin-read-model";
import type { ExecutionHandle } from "@loom/workflow-runtime";
import { Pool } from "pg";
import { buildApp } from "../config";
import { FieldCrypto } from "../crypto/fields";
import { migrate, setAppRolePassword } from "../db/migrate";
import { withTenant } from "../db/tenant";
import { APP_PASSWORD, createTestDb } from "../db/testSupport";
import {
  type IngestWiring,
  closeIngest,
  createIngestWiring,
} from "../flows/ingest-document/limits";
import { pgIngestDeps } from "../flows/ingest-document/pgDeps";
import { createHttpServer } from "../server";
import { runAll } from "../shutdown";
import { IngestStatus } from "../status/ingestStatus";
import { documentEventRoutes } from "./events";
import { InFlight } from "./inFlight";
import { type IngestPort, loomIngest } from "./ingest";
import { DEFAULT_LIMITS, type DocumentLimits } from "./limits";
import { InMemoryProgressBus } from "./progress";
import { type NewDocument, filenameBind, insertDocument, titleBind } from "./repo";
import { type DocumentRoutesDeps, documentRoutes } from "./routes";
import { StartScheduler } from "./startScheduler";

export const T1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const T2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const U1 = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
export const U1B = "a2a2a2a2-a2a2-4a2a-8a2a-a2a2a2a2a2a2"; // a second user of tenant 1
export const U2 = "b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1";

export const ALICE: Identity = { tenantId: T1, userId: U1 };
export const ALICE2: Identity = { tenantId: T1, userId: U1B };
export const BOB: Identity = { tenantId: T2, userId: U2 };

/** Two tenants; tenant 1 has two users. Run as the owner role. */
export async function seedUsers(owner: Pool): Promise<void> {
  await owner.query(`
    INSERT INTO tenants (id, name) VALUES ('${T1}', 'one'), ('${T2}', 'two');
    INSERT INTO users (id, tenant_id, email, password_hash) VALUES
      ('${U1}', '${T1}', 'alice@example.com', 'x'),
      ('${U1B}', '${T1}', 'alice2@example.com', 'x'),
      ('${U2}', '${T2}', 'bob@example.com', 'x')`);
}

export const BY_HEADER: Record<string, Identity> = { alice: ALICE, alice2: ALICE2, bob: BOB };

/** Test-only: who the caller is comes from the `x-test-user` header. */
export const testAuthenticator: Authenticator = {
  async authenticate(req) {
    return BY_HEADER[String(req.headers["x-test-user"])] ?? null;
  },
};

// Smallest inputs the sniffer accepts, plus padding so each is distinct bytes.
export const PNG = (tag = "") =>
  Buffer.concat([Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"), Buffer.from(tag)]);
export const PDF = (tag = "") => Buffer.from(`%PDF-1.7\n${tag}\n%%EOF`);
export const TEXT = (tag = "") => Buffer.from(`some plain text ${tag}\n`);

/** A NewDocument with sealed title and filename; `over` replaces any plain field. */
export async function newDocument(
  fields: FieldCrypto,
  tenantId: string,
  ownerId: string,
  fingerprint: string,
  over: Partial<Omit<NewDocument, "titleEnc" | "filenameEnc">> = {},
): Promise<NewDocument> {
  const id = over.id ?? randomUUID();
  const cipher = fields.forUser(ownerId);
  return {
    id,
    tenantId,
    ownerId,
    titleEnc: await cipher.seal(titleBind(id), "Quarterly report"),
    filenameEnc: await cipher.seal(filenameBind(id), "Quarterly report.pdf"),
    mime: "application/pdf",
    sizeBytes: 10,
    contentAddress: `hmac-sha256:${fingerprint}`,
    fingerprint,
    ...over,
  };
}

export interface IngestProbe {
  /** The execution handle of every start that created an execution, by document id. */
  handles: Map<string, ExecutionHandle>;
  /** "start:<documentId>" and "cancel:<documentId>", in call order. */
  calls: string[];
  hold(): void;
  release(): void;
  /** Holds every start at its entry until `releaseStart()`. */
  holdStart(): void;
  releaseStart(): void;
  failNext(op: "start" | "cancel"): void;
}

/**
 * An in-memory vector store whose `chunkIds` read the real `chunks` table, so the whole pipeline runs
 * against the real table without the pgvector SQL (the acceptance tests run the production store).
 */
export function twinOverPgChunks(app: Pool, wiring: IngestWiring): ChunkVectorStore {
  const chunkIds = (scope: VectorScope, documentId: string) =>
    withTenant(app, scope.tenantId, async (tx) =>
      (
        await tx.query<{ id: string }>(
          "SELECT c.id FROM chunks c JOIN documents d ON d.id = c.document_id AND d.tenant_id = c.tenant_id WHERE c.document_id = $1 AND d.owner_id = $2 ORDER BY c.ordinal",
          [documentId, scope.ownerId],
        )
      ).rows.map((r) => r.id),
    );
  return new InMemoryChunkVectors({
    modelId: wiring.embedder.modelId,
    dimensions: wiring.embedder.dimensions,
    chunkIds,
  });
}

/** A real in-memory Loom app running the ingest stub against `app`, behind a probe. */
function makeIngest(
  app: Pool,
  fields: FieldCrypto,
  blobs: DocumentRoutesDeps["blobs"],
  wiring: IngestWiring,
  vectors: ChunkVectorStore,
): {
  port: IngestPort;
  probe: IngestProbe;
  status: IngestStatus;
  statusStore: InMemoryReadModelStore;
  bus: InMemoryProgressBus;
  close(): Promise<void>;
} {
  const eventStore = new InMemoryAsyncEventStore();
  const statusStore = new InMemoryReadModelStore();
  const bus = new InMemoryProgressBus();
  let gate: Promise<void> | null = null;
  let open: () => void = () => {};
  let startGate: Promise<void> | null = null;
  let openStart: () => void = () => {};
  const real = pgIngestDeps({ pool: app, fields, blobs, wiring, vectors });
  const loom = buildApp({ kind: "custom", eventStore }, undefined, {
    onEvent: (e) => status.onEvent(e),
    ingest: {
      ...real,
      guard: {
        begin: async (ref, step) => {
          await gate;
          return real.guard.begin(ref, step);
        },
      },
    },
  });
  const status = new IngestStatus({
    writer: statusStore,
    readerFor: () => statusStore,
    source: eventStore,
    sensitive: {},
    bus,
    onError: () => {},
  });
  const inner = loomIngest(loom.runtime);
  const failures = { start: 0, cancel: 0 };
  const probe: IngestProbe = {
    handles: new Map(),
    calls: [],
    hold() {
      gate = new Promise<void>((resolve) => {
        open = resolve;
      });
    },
    release() {
      open();
      gate = null;
    },
    holdStart() {
      startGate = new Promise<void>((resolve) => {
        openStart = resolve;
      });
    },
    releaseStart() {
      openStart();
      startGate = null;
    },
    failNext(op) {
      failures[op]++;
    },
  };
  const port: IngestPort = {
    async start(identity, documentId, generation) {
      await startGate;
      probe.calls.push(`start:${documentId}`);
      if (failures.start > 0) {
        failures.start--;
        throw new Error("synthetic-start-error");
      }
      const handle = await inner.start(identity, documentId, generation);
      if (handle) probe.handles.set(documentId, handle);
      return handle;
    },
    async cancel(identity, documentId, generation) {
      probe.calls.push(`cancel:${documentId}`);
      if (failures.cancel > 0) {
        failures.cancel--;
        throw new Error("synthetic-cancel-error");
      }
      await inner.cancel(identity, documentId, generation);
    },
  };
  return {
    port,
    probe,
    status,
    statusStore,
    bus,
    close: async () => {
      probe.release();
      probe.releaseStart();
      await status.close();
      await loom.close();
    },
  };
}

export interface DocumentHarness {
  base: string;
  owner: Pool;
  app: Pool;
  root: string;
  keys: InMemoryKeyStore;
  ingest: IngestProbe;
  /** The parser registry, runner and progress bus (defaults); the real ingest ports are built from them. */
  wiring: IngestWiring;
  inFlight: InFlight;
  starts: StartScheduler;
  /** The ingest-status model the routes read, its stores and the bus its publisher uses. */
  status: IngestStatus;
  statusStore: InMemoryReadModelStore;
  bus: InMemoryProgressBus;
  events: ReturnType<typeof documentEventRoutes>;
  upload(user: string, name: string, data: Uint8Array | string): Promise<Response>;
  /** The keyed fingerprint the server stores for these bytes, for this harness user (alice, alice2, bob). */
  fingerprint(user: string, data: Uint8Array | string): Promise<string>;
  close(): Promise<void>;
}

/** A migrated database with two tenants, a blob directory and the document routes on 127.0.0.1. */
export async function startDocumentServer(
  overrides: {
    limits?: Partial<DocumentLimits>;
    /** Test seam: wraps the route dependencies, e.g. to inject a failure. */
    deps?: (deps: DocumentRoutesDeps) => DocumentRoutesDeps;
  } = {},
): Promise<DocumentHarness> {
  const db = await createTestDb();
  await migrate(db.owner);
  await setAppRolePassword(db.owner, APP_PASSWORD);
  await seedUsers(db.owner);
  const app = new Pool({ connectionString: db.appUrl });
  const root = mkdtempSync(join(tmpdir(), "dm-docs-"));
  const keys = new InMemoryKeyStore();
  const limits = { ...DEFAULT_LIMITS, ...overrides.limits };
  const fields = new FieldCrypto(keys);
  const blobs: DocumentRoutesDeps["blobs"] = (id) =>
    new EncryptedFsContentStore({
      root,
      tenantId: id.tenantId,
      userId: id.userId,
      keys,
      maxBytes: limits.maxFileBytes,
    });
  const fake = await startFakeOllama({ dimensions: 64, model: "fake-embed" });
  try {
    const wiring = createIngestWiring({
      DOCMIND_OLLAMA_URL: fake.url,
      DOCMIND_EMBED_MODEL: "fake-embed",
      DOCMIND_EMBED_DIMENSIONS: "64",
    });
    // The ingest source reads through whatever `deps` finally gives the routes (a failing store reaches both).
    let effectiveBlobs = blobs;
    const ingest = makeIngest(
      app,
      fields,
      (id) => effectiveBlobs(id),
      wiring,
      twinOverPgChunks(app, wiring),
    );
    const inFlight = new InFlight();
    await ingest.status.boot();
    const wrap = overrides.deps ?? ((d: DocumentRoutesDeps) => d);
    const wrapped = wrap({
      pool: app,
      authenticator: testAuthenticator,
      fields,
      blobs,
      limits,
      ingest: ingest.port,
      status: ingest.status,
      starts: new StartScheduler(ingest.port),
      inFlight,
    });
    effectiveBlobs = wrapped.blobs;
    // A wrapper that replaces `ingest` (an injected failure or gate) gets a scheduler over its port.
    const starts =
      wrapped.ingest === ingest.port ? wrapped.starts : new StartScheduler(wrapped.ingest);
    const events = documentEventRoutes({ authenticator: testAuthenticator, bus: ingest.bus });
    const server = createHttpServer({
      ...documentRoutes({ ...wrapped, starts }),
      ...events.routes,
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return {
      base,
      owner: db.owner,
      app,
      root,
      keys,
      ingest: ingest.probe,
      wiring,
      inFlight,
      starts,
      status: ingest.status,
      statusStore: ingest.statusStore,
      bus: ingest.bus,
      events,
      upload(user, name, data) {
        const form = new FormData();
        form.append("file", new Blob([data]), name);
        return fetch(`${base}/api/documents`, {
          method: "POST",
          headers: { "x-test-user": user },
          body: form,
        });
      },
      async fingerprint(user, data) {
        const identity = BY_HEADER[user];
        if (!identity) throw new Error("unknown harness user");
        const dek = await keys.getOrCreate(identity.userId);
        return fingerprintOf(
          deriveFingerprintKey(dek),
          typeof data === "string" ? Buffer.from(data) : data,
        );
      },
      async close() {
        ingest.probe.release();
        ingest.probe.releaseStart();
        events.closeAll();
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        });
        await starts.idle(); // after the server stops, nothing can fire anymore
        // The runner first (kills children, as main does), and a throw must not skip the rest.
        await runAll(
          () => closeIngest(wiring),
          () => ingest.close(),
          () => app.end(),
          () => fake.close(),
        );
        await db.drop();
        rmSync(root, { recursive: true, force: true });
      },
    };
  } catch (err) {
    await fake.close(); // a later setup step failed: the fake would otherwise leak
    throw err;
  }
}

// A document of `who`, created `ageSeconds` ago, as the owner role.
export async function seedDoc(
  owner: Pool,
  app: Pool,
  fields: FieldCrypto,
  who: Identity,
  fingerprint: string,
  ageSeconds: number,
) {
  const d = await newDocument(fields, who.tenantId, who.userId, fingerprint);
  await withTenant(app, who.tenantId, (tx) => insertDocument(tx, d));
  await owner.query(
    "UPDATE documents SET created_at = now() - make_interval(secs => $2::float8), updated_at = now() - make_interval(secs => $2::float8) WHERE id = $1",
    [d.id, ageSeconds],
  );
  return d.id;
}
// What the status model's writer would have stored for an execution.
export const seedRow = (
  owner: Pool,
  executionId: string,
  key: string,
  scope: string,
  state = "{}",
) =>
  owner.query(
    "INSERT INTO read_model_state (model_id, execution_id, app_key, scope, sequence, state) VALUES ('ingest-status', $1, $2, $3, 0, $4)",
    [executionId, key, scope, state],
  );

/** Opens a server-sent-event stream; `next()` resolves with the next complete frame, without its blank line. */
export async function openSse(url: string, headers: Record<string, string>) {
  const controller = new AbortController();
  const res = await fetch(url, { headers, signal: controller.signal });
  const reader = res.body?.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const next = async (): Promise<string> => {
    while (!buffer.includes("\n\n")) {
      const { value, done } = (await reader?.read()) ?? { done: true, value: undefined };
      if (done) throw new Error("stream ended");
      buffer += decoder.decode(value);
    }
    const end = buffer.indexOf("\n\n");
    const frame = buffer.slice(0, end);
    buffer = buffer.slice(end + 2);
    return frame;
  };
  return { res, next, close: () => controller.abort() };
}
