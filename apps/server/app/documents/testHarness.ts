import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Authenticator, Identity } from "@docmind/auth";
import { EncryptedFsContentStore, deriveFingerprintKey, fingerprintOf } from "@docmind/blob-store";
import { InMemoryKeyStore } from "@loom/plugin-crypto";
import type { ExecutionHandle } from "@loom/workflow-runtime";
import { Pool } from "pg";
import { buildApp } from "../config";
import { FieldCrypto } from "../crypto/fields";
import { migrate, setAppRolePassword } from "../db/migrate";
import { APP_PASSWORD, createTestDb } from "../db/testSupport";
import { pgIngestDeps } from "../flows/ingest-document/pgDeps";
import { createHttpServer } from "../server";
import { type IngestPort, loomIngest } from "./ingest";
import { DEFAULT_LIMITS, type DocumentLimits } from "./limits";
import { type NewDocument, filenameBind, titleBind } from "./repo";
import { type DocumentRoutesDeps, documentRoutes } from "./routes";

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
  failNext(op: "start" | "cancel"): void;
}

/** A real in-memory Loom app running the ingest stub against `app`, behind a probe. */
function makeIngest(app: Pool): { port: IngestPort; probe: IngestProbe; close(): Promise<void> } {
  let gate: Promise<void> | null = null;
  let open: () => void = () => {};
  const real = pgIngestDeps(app);
  const loom = buildApp({ kind: "memory" }, undefined, {
    ingest: {
      documentExists: async (ref) => {
        await gate;
        return real.documentExists(ref);
      },
    },
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
    failNext(op) {
      failures[op]++;
    },
  };
  const port: IngestPort = {
    async start(identity, documentId) {
      probe.calls.push(`start:${documentId}`);
      if (failures.start > 0) {
        failures.start--;
        throw new Error("synthetic-start-error");
      }
      const handle = await inner.start(identity, documentId);
      if (handle) probe.handles.set(documentId, handle);
      return handle;
    },
    async cancel(identity, documentId) {
      probe.calls.push(`cancel:${documentId}`);
      if (failures.cancel > 0) {
        failures.cancel--;
        throw new Error("synthetic-cancel-error");
      }
      await inner.cancel(identity, documentId);
    },
  };
  return {
    port,
    probe,
    close: async () => {
      probe.release();
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
  const ingest = makeIngest(app);
  const wrap = overrides.deps ?? ((d: DocumentRoutesDeps) => d);
  const server = createHttpServer(
    documentRoutes(
      wrap({
        pool: app,
        authenticator: testAuthenticator,
        fields: new FieldCrypto(keys),
        blobs: (id) =>
          new EncryptedFsContentStore({
            root,
            tenantId: id.tenantId,
            userId: id.userId,
            keys,
            maxBytes: limits.maxFileBytes,
          }),
        limits,
        ingest: ingest.port,
      }),
    ),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    owner: db.owner,
    app,
    root,
    keys,
    ingest: ingest.probe,
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
      await ingest.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      await app.end();
      await db.drop();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
