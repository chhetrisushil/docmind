import { type KeyObject, createSecretKey, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FakeOllama, startFakeOllama } from "@docmind/embeddings/testing";
import { PostgresKeyStore } from "@docmind/keystore-pg";
import { type FakeAnthropic, startFakeAnthropic } from "@docmind/llm-anthropic/testing";
import { Pool } from "pg";
import { bootIngest } from "../bootIngest";
import { createChatLlm } from "../chats/llm";
import { loadChatSettings } from "../chats/settings";
import { buildServer } from "../compose";
import { FieldCrypto } from "../crypto/fields";
import { migrate, setAppRolePassword, setRolePassword } from "../db/migrate";
import { APP_PASSWORD, LOOM_PASSWORD, type TestDb, createTestDb } from "../db/testSupport";
import { createTitleLlm } from "../flows/chat-title/llm";
import { closeIngest, createIngestWiring } from "../flows/ingest-document/limits";
import { runAll } from "../shutdown";
import { pgStatusReaderFor, pgStatusWriter, pgUserExecutions } from "../status/pgStores";
import { type DurableStorage, openDurableStorage } from "../storage";
import { loadBlobRoot, loadLimits } from "./limits";
import { openSse } from "./testHarness";

const PASSWORD = "correct horse battery";

export const CHAT_TEST_ENVELOPE_KEY = "chat-envelope-key-for-tests-0123456789"; // a test value, not a secret

export interface IngestStackOptions {
  /** A Claude key and a FakeAnthropic for the chat only; ingest stays keyless. */
  chat?: boolean;
  /** Reuse an earlier stack's database, key-encryption key and blob root: a restart over the same event store. */
  resume?: { db: TestDb; kek: KeyObject; root?: string };
}

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
  kek: KeyObject;
  /** Present with the `chat` option. */
  claude?: FakeAnthropic;
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
  /** A request with the cookie's session; a JSON body when given. */
  chatReq(cookie: string, method: string, path: string, body?: unknown): Promise<Response>;
  openChat(
    cookie: string,
    chatId: string,
    headers?: Record<string, string>,
  ): ReturnType<typeof openSse>;
  /** `keepDb` leaves the database and the blob root for a `resume` stack. */
  close(opts?: { keepDb?: boolean }): Promise<void>;
}

/**
 * The production composition over real HTTP: real child-process parser, fake Ollama, Loom on durable
 * Postgres, the real chunks table and pgvector store, the two-role status stores. It boots in main's
 * order (verifyVectors, status boot, recovery, listen, sweeper) and closes in main's order.
 */
export async function startIngestStack(options: IngestStackOptions = {}): Promise<IngestStack> {
  const db = options.resume?.db ?? (await createTestDb());
  const cleanups: (() => Promise<unknown>)[] = [];
  try {
    if (!options.resume) {
      await migrate(db.owner);
      await setAppRolePassword(db.owner, APP_PASSWORD);
      await setRolePassword(db.owner, "docmind_loom", LOOM_PASSWORD);
    }
    const app = new Pool({ connectionString: db.appUrl });
    cleanups.unshift(() => app.end());
    const root = options.resume?.root ?? mkdtempSync(join(tmpdir(), "dm-ingest-e2e-"));
    cleanups.unshift(async () => rmSync(root, { recursive: true, force: true }));
    const kek = options.resume?.kek ?? createSecretKey(randomBytes(32));
    const keys = new PostgresKeyStore(app, [{ id: "kek-1", key: kek }]);
    const fields = new FieldCrypto(keys);
    const durable = await openDurableStorage({ loomUrl: db.loomUrl, keys });
    cleanups.unshift(() => durable.close());
    const fake = await startFakeOllama({ dimensions: 768, model: "fake-embed" }); // the migration fixes 768
    cleanups.unshift(() => fake.close());
    const claude = options.chat ? await startFakeAnthropic() : undefined;
    cleanups.unshift(async () => void (await claude?.close()));
    const wiring = createIngestWiring({
      DOCMIND_OLLAMA_URL: fake.url,
      DOCMIND_EMBED_MODEL: "fake-embed",
      DOCMIND_EMBED_DIMENSIONS: "768",
    });
    // The retry policy's backoff is the one timer a test must not wait on: attempts still run, back to back.
    wiring.sleep = async () => {};
    cleanups.unshift(() => closeIngest(wiring));
    const chatEnv = claude
      ? {
          ANTHROPIC_API_KEY: "test-key-not-real",
          ANTHROPIC_BASE_URL: claude.url,
          DOCMIND_CHAT_ENVELOPE_KEY: CHAT_TEST_ENVELOPE_KEY,
          DOCMIND_TITLE_MODEL: "title-model",
        }
      : {};
    const settings = loadChatSettings(chatEnv);
    const llm = createChatLlm(chatEnv, settings);
    const titleLlm = createTitleLlm(chatEnv, settings);
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
        userExecutions: pgUserExecutions(durable.pool),
      },
      chat: {
        settings,
        ...(llm && { llm }),
        ...(titleLlm && { titleLlm }),
        timers: durable.timers,
      },
      // no `vectors`: the production PgChunkVectorStore over the real chunks table
    });
    const { server } = composed;
    cleanups.unshift(() => composed.app.close());

    // The same boot function main uses; the stack binds an ephemeral port.
    const boot = await bootIngest({
      built: composed,
      ingest: wiring,
      durable,
      pool: app,
      recoveryOwner: randomUUID(),
      listen: () => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)),
      drainServer: async (then) => {
        try {
          await new Promise<void>((resolve) => {
            server.close(() => resolve());
            server.closeAllConnections();
          });
        } finally {
          await then();
        }
      },
    });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

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

    const chatReq = (cookie: string, method: string, path: string, body?: unknown) =>
      fetch(`${base}${path}`, {
        method,
        headers: { cookie, ...(body !== undefined && { "content-type": "application/json" }) },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
    const openChat = (cookie: string, chatId: string, headers: Record<string, string> = {}) =>
      openSse(`${base}/api/chats/${chatId}/stream`, { cookie, ...headers });

    return {
      base,
      db,
      app,
      keys,
      fields,
      durable,
      fake,
      kek,
      ...(claude && { claude }),
      composed,
      root,
      signUpAndLogIn,
      upload,
      chatReq,
      openChat,
      events: openEvents,
      until,
      failNextStart: () => {
        failStarts++;
      },
      async close(opts: { keepDb?: boolean } = {}) {
        // main's stop(): timers, open streams, the server drain, then the close sequence.
        await runAll(
          boot.stop,
          () => fake.close(),
          async () => void (await claude?.close()),
        );
        if (opts.keepDb) return;
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
