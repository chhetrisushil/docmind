import { createHash, createSecretKey, randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  DocumentDto,
  ListDocumentsResponse,
  UploadDocumentResponse,
} from "@docmind/contracts";
import { type FakeOllama, startFakeOllama } from "@docmind/embeddings/testing";
import { PostgresKeyStore } from "@docmind/keystore-pg";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryReadModelStore } from "@loom/plugin-read-model";
import type { ExecutionHandle } from "@loom/workflow-runtime";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../compose";
import { migrate, setAppRolePassword } from "../db/migrate";
import { APP_PASSWORD, PG_URL, type TestDb, createTestDb } from "../db/testSupport";
import { createIngestWiring } from "../flows/ingest-document/limits";
import { loadBlobRoot, loadLimits } from "./limits";
import { PDF, PNG, twinOverPgChunks } from "./testHarness";

const PASSWORD = "correct horse battery";

const filesUnder = (root: string) =>
  readdirSync(root, { recursive: true, withFileTypes: true }).filter((e) => e.isFile());

describe.skipIf(!PG_URL)(
  "M2 acceptance: upload, list, get, delete (needs DOCMIND_TEST_PG_URL)",
  () => {
    let db: TestDb;
    let app: Pool;
    let server: ReturnType<typeof buildServer>["server"];
    let base = "";
    let root = "";
    let loom: ReturnType<typeof buildServer>["app"] | undefined;
    let status: ReturnType<typeof buildServer>["status"] | undefined;
    const calls: string[] = [];
    const handles = new Map<string, ExecutionHandle>();
    let fake: FakeOllama | undefined;

    beforeAll(async () => {
      db = await createTestDb();
      await migrate(db.owner);
      await setAppRolePassword(db.owner, APP_PASSWORD);
      app = new Pool({ connectionString: db.appUrl });
      root = mkdtempSync(join(tmpdir(), "dm-e2e-"));
      const keys = new PostgresKeyStore(app, [
        { id: "kek-1", key: createSecretKey(randomBytes(32)) },
      ]);
      // The production composition (main.ts calls the same function): only the pool, memory Loom
      // storage, a temp blob root and the env are the test's. Limits and blob root go through the
      // production parsers. The wrapper records start and cancel and keeps the flow handles.
      fake = await startFakeOllama({ dimensions: 64, model: "fake-embed" });
      const wiring = createIngestWiring({
        DOCMIND_OLLAMA_URL: fake.url,
        DOCMIND_EMBED_MODEL: "fake-embed",
        DOCMIND_EMBED_DIMENSIONS: "64",
      });
      const eventStore = new InMemoryAsyncEventStore();
      const statusStore = new InMemoryReadModelStore();
      const composed = buildServer({
        pool: app,
        keys,
        storage: { kind: "custom", eventStore },
        status: { writer: statusStore, readerFor: () => statusStore, source: eventStore },
        limits: loadLimits({}),
        blobRoot: loadBlobRoot({ DOCMIND_BLOB_DIR: root }),
        secureCookies: false,
        trustProxy: false,
        ingest: wiring,
        vectors: twinOverPgChunks(app, wiring), // the production vector store runs in the acceptance tasks
        wrapIngest: (real) => ({
          async start(identity, documentId, generation) {
            calls.push(`start:${documentId}`);
            const handle = await real.start(identity, documentId, generation);
            if (handle) handles.set(documentId, handle);
            return handle;
          },
          async cancel(identity, documentId, generation) {
            calls.push(`cancel:${documentId}`);
            await real.cancel(identity, documentId, generation);
          },
        }),
      });
      await composed.status.boot();
      loom = composed.app;
      status = composed.status;
      server = composed.server;
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterAll(async () => {
      if (server) {
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        });
      }
      await status?.close();
      await loom?.close();
      await app?.end();
      await fake?.close();
      await db?.drop();
      if (root) rmSync(root, { recursive: true, force: true });
    });

    async function signUpAndLogIn(email: string): Promise<string> {
      const json = (path: string) =>
        fetch(`${base}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email, password: PASSWORD }),
        });
      expect((await json("/api/auth/sign-up")).status).toBe(202);
      const login = await json("/api/auth/login");
      expect(login.status).toBe(200);
      return (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    }

    const upload = (cookie: string, name: string, data: Uint8Array) => {
      const form = new FormData();
      form.append("file", new Blob([data]), name);
      return fetch(`${base}/api/documents`, { method: "POST", headers: { cookie }, body: form });
    };
    const get = (cookie: string, path: string) => fetch(`${base}${path}`, { headers: { cookie } });

    it("lets two signed-up users store, list, read and delete their own documents, and no one else's", async () => {
      const ada = await signUpAndLogIn("ada@example.com");
      const grace = await signUpAndLogIn("grace@example.com");
      const secretName = "Ada private diary.txt";
      const secretText = "my very private words";

      const a1 = (await (
        await upload(ada, secretName, Buffer.from(`${secretText}\n`))
      ).json()) as UploadDocumentResponse;
      const a2 = (await (
        await upload(ada, "scan.png", PNG("ada"))
      ).json()) as UploadDocumentResponse;
      const g1 = await upload(grace, "report.pdf", PDF("grace"));
      expect(g1.status).toBe(201);
      const graceDoc = ((await g1.json()) as UploadDocumentResponse).document;

      // the upload started the real ingest flow, with the owner's execution id and ids only
      const started = handles.get(a1.document.id);
      expect(started?.executionId).toMatch(/^u_[0-9a-f-]{36}:ingest-[0-9a-f-]{36}(\.\d+)?$/);
      const done = await started?.waitForCompletion();
      expect(done?.variables._output).toEqual({ outcome: "done" });
      expect(done?.status).toBe("completed");
      // every upload started one flow; let them all finish so teardown does not race a live run
      expect(handles.size).toBe(3);
      for (const handle of handles.values()) {
        expect((await handle.waitForCompletion()).status).toBe("completed");
      }

      // list: each sees only their own
      const adaList = (await (await get(ada, "/api/documents")).json()) as ListDocumentsResponse;
      expect(adaList.items.map((d) => d.id).sort()).toEqual(
        [a1.document.id, a2.document.id].sort(),
      );
      const graceList = (await (
        await get(grace, "/api/documents")
      ).json()) as ListDocumentsResponse;
      expect(graceList.items.map((d) => d.id)).toEqual([graceDoc.id]);

      // get: own works, the other's is a plain 404, no cookie is a 401
      const read = (await (
        await get(ada, `/api/documents/${a1.document.id}`)
      ).json()) as DocumentDto;
      expect(read).toMatchObject({ filename: secretName, title: "Ada private diary" });
      expect(read.status).toBe("ready");
      expect((await get(ada, `/api/documents/${graceDoc.id}`)).status).toBe(404);
      expect((await fetch(`${base}/api/documents`)).status).toBe(401);

      // row-level security holds for the app role even without going through the API
      expect((await app.query("SELECT 1 FROM documents")).rowCount).toBe(0);

      // at rest: the owner's view of the table holds no plain sha256, and file names are keyed
      // fingerprints. (No plaintext probes over ciphertext: they would pass by chance.)
      const dump = await db.owner.query("SELECT row_to_json(d)::text AS j FROM documents d");
      const plain = createHash("sha256").update(`${secretText}\n`).digest("hex");
      expect(dump.rows.map((r) => r.j).join("")).not.toContain(plain);
      const files = filesUnder(root);
      expect(files.length).toBe(3);
      expect(files.map((f) => f.name)).not.toContain(plain);
      const dirs = readdirSync(root, { recursive: true, withFileTypes: true }).filter((e) =>
        e.isDirectory(),
      );
      for (const d of dirs) {
        expect(statSync(join(d.parentPath ?? d.path, d.name)).mode & 0o077).toBe(0);
      }

      // cross-user: another user can neither read nor delete Ada's document, and nothing changes
      expect((await get(grace, `/api/documents/${a1.document.id}`)).status).toBe(404);
      const foreign = await fetch(`${base}/api/documents/${a1.document.id}`, {
        method: "DELETE",
        headers: { cookie: grace },
      });
      expect(foreign.status).toBe(404);
      expect((await get(ada, `/api/documents/${a1.document.id}`)).status).toBe(200);
      expect(filesUnder(root).length).toBe(3);

      // delete: the flow is cancelled first, row and blob are gone; the other user's is untouched
      const del = await fetch(`${base}/api/documents/${a1.document.id}`, {
        method: "DELETE",
        headers: { cookie: ada },
      });
      expect(del.status).toBe(204);
      expect(calls).toContain(`cancel:${a1.document.id}`);
      expect((await get(ada, `/api/documents/${a1.document.id}`)).status).toBe(404);
      const after = (await (await get(ada, "/api/documents")).json()) as ListDocumentsResponse;
      expect(after.items.map((d) => d.id)).toEqual([a2.document.id]);
      expect(filesUnder(root).length).toBe(2);
      expect((await get(grace, `/api/documents/${graceDoc.id}`)).status).toBe(200);
    });
  },
);
