import { randomBytes } from "node:crypto";
import { AuthService, type Identity, PasswordAuthenticator } from "@docmind/auth";
import { EncryptedFsContentStore } from "@docmind/blob-store";
import { createViews } from "@docmind/experiences";
import { type ChunkVectorStore, PgChunkVectorStore } from "@docmind/vector-pg";
import type { PrincipalCryptoOptions, StorageConfig } from "@loom/app";
import { createConversationReader } from "@loom/conversation";
import type { EventEnvelope } from "@loom/core";
import type { EventStore, TimerStore } from "@loom/event-runtime";
import type { LlmProvider } from "@loom/llm";
import type { KeyStore } from "@loom/plugin-crypto";
import type { ReadModelStore } from "@loom/plugin-read-model";
import { Pool, type QueryConfig } from "pg";
import { PgAuthStore } from "./auth/pgAuthStore";
import { PgThrottle } from "./auth/pgThrottle";
import { authRoutes } from "./auth/routes";
import { ChatActivity } from "./chats/activity";
import type { ChatLlm } from "./chats/llm";
import { pgCollaborators } from "./chats/pgCollaborators";
import { replyReasoning } from "./chats/reasoningRead";
import { chatRoutes } from "./chats/routes";
import type { ChatSettings } from "./chats/settings";
import { chatStreamRoutes } from "./chats/stream";
import { connectChat, prepareChat } from "./chats/wiring";
import { buildApp } from "./config";
import { FieldCrypto } from "./crypto/fields";
import { withTenant } from "./db/tenant";
import { documentEventRoutes } from "./documents/events";
import { type IngestPort, loomIngest } from "./documents/ingest";
import type { DocumentLimits } from "./documents/limits";
import { documentRoutes } from "./documents/routes";
import { StartScheduler } from "./documents/startScheduler";
import { pgAccountErasure } from "./erasure/account";
import type { ErasureWiring } from "./erasure/compliance";
import { ERASURE_CONCURRENCY, Eraser, type ErasureDeps } from "./erasure/eraser";
import { pgErasureSql } from "./erasure/pgSteps";
import { PgErasureStore } from "./erasure/pgStore";
import { tolerantSource } from "./erasure/tolerantSource";
import { erasureDeps, requireKeyDestroyedProof } from "./erasure/wire";
import { loomTitleStarter } from "./flows/chat-title/start";
import type { IngestWiring } from "./flows/ingest-document/limits";
import { pgIngestDeps } from "./flows/ingest-document/pgDeps";
import { READY_PING_TIMEOUT_MS, createReadiness } from "./http/readiness";
import { staticHandler } from "./http/staticFiles";
import { createHttpServer } from "./server";
import type { UserExecutionLister } from "./status/forgetUser";
import { type DocumentStatusReads, IngestStatus } from "./status/ingestStatus";
import { flowSteps, statusSensitive } from "./status/wire";
import { uiRoutes } from "./ui/routes";

/** The stores behind the ingest-status model: in production the Loom-pool writer and the tenant-bound reader. */
export interface StatusStores {
  writer: ReadModelStore;
  readerFor(identity: Identity): ReadModelStore;
  /** The decrypting event store the model reads (live and catch-up source); its sealing covers feed the sensitive map. */
  source: EventStore;
  /** User erasure's reader of the Loom pool (`pgUserExecutions`). Absent (most tests): the models purge by scope only. */
  userExecutions?: UserExecutionLister;
}

export interface ComposeOptions {
  /** SSE heartbeat (which also re-checks the session). Tests pin it so a stream can only end because the server closed it. */
  heartbeatMs?: number;
  /**
   * M5: the raw (unwrapped) stores erasure shreds on. With it the app is built with `compliance`,
   * `bootIngest` hydrates the subject index, and the `Eraser` is composed. `loomPool` is the Loom pool (the eraser
   * removes the user's leftover timers and leases). Absent: no erasure and no eraser (the CLI, most tests).
   * `wrap` and `sleep` are test seams: a crash test wraps a step, the acceptance stack shortens the backoff.
   */
  erasure?: {
    raw: ErasureWiring["raw"];
    loomPool: Pool;
    wrap?: (deps: ErasureDeps) => ErasureDeps;
    sleep?: ErasureDeps["sleep"];
  };
  /** The docmind_app pool: auth, documents and the ingest step read through it. */
  pool: Pool;
  keys: KeyStore;
  storage: StorageConfig;
  crypto?: PrincipalCryptoOptions;
  limits: DocumentLimits;
  blobRoot: string;
  secureCookies: boolean;
  trustProxy: boolean;
  /** `DOCMIND_TRUST_PROXY_HOPS`, already validated; the proxies between the client and this server. Default 1. */
  trustProxyHops?: number;
  /** `DOCMIND_PUBLIC_ORIGIN`, already validated; the origin guard compares `Origin` against it. */
  publicOrigin?: string;
  /** `DOCMIND_WEB_DIR`, already validated. */
  webDir?: string;
  /** `DOCMIND_MAX_CONNECTIONS`, already validated. */
  maxConnections?: number;
  /** `DOCMIND_KEEP_ALIVE_TIMEOUT_MS` and `DOCMIND_HEADERS_TIMEOUT_MS`, already validated. */
  httpTimeouts?: { keepAliveTimeoutMs: number; headersTimeoutMs: number };
  /** Parser registry, runner and progress bus; the runner and registry reach the parse ports through pgIngestDeps. */
  ingest: IngestWiring;
  /** The ingest-status model's stores. */
  status: StatusStores;
  /** Test seam: the vector store. Defaults to the Pg store over `withTenant` on the app pool (never the Loom pool). */
  vectors?: ChunkVectorStore & { verify?(tenantId: string): Promise<void> };
  /** Test seam: observe or wrap the ingest port the routes use. */
  wrapIngest?: (port: IngestPort) => IngestPort;
  /** M4 chat: the settings, the chat LLM provider (absent when chat is off) and the timer store. Absent: no chat (the CLI, most tests). */
  chat?: { settings: ChatSettings; llm?: ChatLlm; titleLlm?: LlmProvider; timers: TimerStore };
}

/**
 * Everything `main` runs, minus configuration and process concerns: the Loom app with the ingest
 * step's database access, the auth and document routes, and the HTTP server (not yet listening).
 * The acceptance test builds the server through this same function.
 */
export function buildServer(options: ComposeOptions) {
  const { pool, keys, limits } = options;
  type Sink = (event: EventEnvelope) => void;
  // The sinks are built after defineConfig (the sensitive map needs it); onEvent reaches them through this holder.
  const feed: { sinks: Sink[] } = { sinks: [] };
  const fields = new FieldCrypto(keys);
  // The per-identity blob store, built the same way for the routes and the ingest source.
  const blobs = ({ tenantId, userId }: Identity) =>
    new EncryptedFsContentStore({
      root: options.blobRoot,
      tenantId,
      userId,
      keys,
      maxBytes: limits.maxFileBytes,
    });
  const { embedder } = options.ingest;
  const vectors =
    options.vectors ??
    new PgChunkVectorStore({
      tenant: (tenantId, fn) => withTenant(pool, tenantId, fn),
      modelId: embedder.modelId,
      dimensions: embedder.dimensions,
    });
  // The status model is built after the app (its sensitive map needs defineConfig), and the document tools read it: late-bound.
  const statusReads: Pick<DocumentStatusReads, "forPage"> = {
    forPage: (who, docs) => status.forPage(who, docs),
  };
  const titleLlm = options.chat?.titleLlm;
  const chatParts = options.chat
    ? prepareChat({
        settings: options.chat.settings,
        ...(options.chat.llm && { llm: options.chat.llm }),
        timers: options.chat.timers,
        eventStore: options.status.source,
        collaborators: pgCollaborators({
          pool,
          fields,
          vectors,
          embedder,
          hops: options.chat.settings.hops,
          status: statusReads,
        }),
      })
    : undefined;
  const app = buildApp(options.storage, options.crypto, {
    ingest: pgIngestDeps({ pool, fields, keys, blobs, wiring: options.ingest, vectors }),
    ...(chatParts && { chat: chatParts.deps }),
    ...(options.chat && {
      chatTitle: {
        pool,
        fields,
        reader: createConversationReader(options.status.source), // a reader is only the decrypting event store
        ...(titleLlm && { llm: titleLlm }),
      },
    }),
    ...(options.erasure && { erasure: { keys, raw: options.erasure.raw } }),
    onEvent: (event) => {
      for (const sink of feed.sinks) {
        try {
          sink(event);
        } catch (err) {
          // One sink's failure never reaches Loom or the other sinks. Class only.
          console.error(
            "event sink failed",
            err instanceof Error ? err.constructor.name : typeof err,
          );
        }
      }
    },
  });
  const titles = options.chat && loomTitleStarter(app.runtime);
  const chat = chatParts && connectChat(chatParts, app.runtime, options.status.source);
  const sensitive = statusSensitive(flowSteps(), options.status.source);
  // The models fold through a source that reads an erased user's log as placeholders instead of throwing (E5). The
  // runtime, the chat reads and every authoritative read keep the strict `options.status.source`.
  const foldSource = options.erasure
    ? tolerantSource({ raw: options.erasure.raw.eventStore, keys, strict: options.status.source })
    : options.status.source;
  const status = new IngestStatus({
    writer: options.status.writer,
    readerFor: options.status.readerFor,
    source: foldSource,
    sensitive,
    bus: options.ingest.bus,
    ...(options.status.userExecutions && { userExecutions: options.status.userExecutions }),
  });
  const activity = new ChatActivity({
    writer: options.status.writer,
    source: foldSource,
    sensitive,
    ...(options.status.userExecutions && { userExecutions: options.status.userExecutions }),
  });
  feed.sinks = [status.onEvent, activity.onEvent];
  const ingest = options.wrapIngest
    ? options.wrapIngest(loomIngest(app.runtime))
    : loomIngest(app.runtime);
  const starts = new StartScheduler(ingest);
  // The keys are per process: a restart changes the handle revisions (a connected client sees one extra reload), and two
  // processes behind one balancer would answer different versionHash values. DocMind is single-process (spec section 10).
  // A finding is logged as its code alone: never the handle, the params or the value.
  const views = createViews({
    placeholderKey: randomBytes(32).toString("hex"),
    revisionKey: randomBytes(32).toString("hex"),
    onFinding: (_handle, code) => console.error(`ui finding ${code}`),
  });
  const store = new PgAuthStore(pool);
  const throttle = new PgThrottle(pool);
  const authenticator = new PasswordAuthenticator(store);
  const events = documentEventRoutes({
    authenticator,
    bus: options.ingest.bus,
    ...(options.heartbeatMs && { heartbeatMs: options.heartbeatMs }),
  });
  const reasoning = chat && replyReasoning({ log: options.status.source, store: chat.reasoning });
  const chatStreams =
    chat &&
    reasoning &&
    chatStreamRoutes({
      pool,
      authenticator,
      fields,
      chat,
      eventStore: options.status.source,
      reasoning,
      ...(options.heartbeatMs && { heartbeatMs: options.heartbeatMs }),
    });
  // After the streams exist: the eraser closes them per user.
  const erasure = options.erasure;
  if (erasure) requireKeyDestroyedProof(keys);
  // Advisory locks live on a small pool of their own, on the same app connection settings: a lock held through a
  // backoff must never take a connection the app or the key store needs.
  const erasureLocks = erasure
    ? new Pool({ ...pool.options, max: ERASURE_CONCURRENCY + 1, connectionTimeoutMillis: 10_000 })
    : undefined;
  const erasureStore = erasure && new PgErasureStore(pool);
  const eraser =
    erasure && erasureLocks && erasureStore
      ? new Eraser(
          (erasure.wrap ?? ((d: ErasureDeps) => d))(
            erasureDeps({
              app,
              runtime: app.runtime,
              keys,
              store: erasureStore,
              sql: pgErasureSql({
                app: pool,
                locks: erasureLocks,
                loom: erasure.loomPool,
                blobRoot: options.blobRoot,
              }),
              starts,
              ...(titles && { titles }),
              ingest,
              ...(chat && { chat }),
              status,
              activity,
              closeStreams: (userId) => {
                events.closeUser(userId);
                chatStreams?.closeUser(userId);
              },
              ...(erasure.sleep && { sleep: erasure.sleep }),
            }),
          ),
        )
      : undefined;
  const account =
    eraser && erasureStore
      ? pgAccountErasure({
          pool,
          store: erasureStore,
          eraser,
          closeStreams: (userId) => {
            events.closeUser(userId);
            chatStreams?.closeUser(userId);
          },
        })
      : undefined;
  // The probe pings the app pool with the cheapest query there is; `stop()` flips it before the drain.
  const readiness = createReadiness({
    // node-postgres honours `query_timeout` per query but its typings omit it; the cap frees the connection from a hung database.
    ping: async () => {
      await pool.query({ text: "SELECT 1", query_timeout: READY_PING_TIMEOUT_MS } as QueryConfig);
    },
  });
  const server = createHttpServer(
    {
      "GET /readyz": readiness.handler,
      ...authRoutes({
        service: new AuthService(store),
        authenticator,
        store,
        throttle,
        secureCookies: options.secureCookies,
        trustProxy: options.trustProxy,
        ...(options.trustProxyHops !== undefined && { trustProxyHops: options.trustProxyHops }),
        ...(account && { erasure: account }),
      }),
      ...documentRoutes({
        pool,
        authenticator,
        fields,
        blobs,
        limits,
        registry: options.ingest.registry,
        ingest,
        starts,
        status,
      }),
      ...uiRoutes({
        authenticator,
        views,
        readers: { pool, fields, status, blobs, registry: options.ingest.registry },
      }),
      ...(chat &&
        reasoning &&
        chatRoutes({
          pool,
          authenticator,
          fields,
          chat,
          eventStore: options.status.source,
          reasoning,
          ...(titleLlm && titles && { titles }),
        })),
      ...events.routes, // exact route, matched before `GET /api/documents/:id`
      ...(chatStreams?.routes ?? {}),
    },
    { secure: options.secureCookies, publicOrigin: options.publicOrigin },
    {
      ...(options.maxConnections !== undefined && { maxConnections: options.maxConnections }),
      ...options.httpTimeouts,
    },
    options.webDir ? staticHandler(options.webDir) : undefined,
  );
  return {
    app,
    server,
    /** `GET /readyz`: shutdown calls `beginShutdown()` as its first step. */
    readiness,
    store,
    throttle,
    starts,
    ingestWiring: options.ingest,
    vectors,
    bus: options.ingest.bus,
    status,
    activity,
    /** The chat wiring; absent when `options.chat` is. Its routes are mounted from `chatRoutes`. */
    chat,
    /** Starts a chat's auto title; absent when `options.chat` is. `idle()` is awaited at shutdown with the ingest starts. */
    titles,
    /** Ends every open progress stream; shutdown calls it before the server drain (an event stream never ends on its own). */
    events,
    /** Ends every open chat stream; shutdown calls it right after `events.closeAll()` (a stream never ends on its own). Absent without chat. */
    chatStreams,
    /** Runs and resumes erasures; absent without options.erasure. Boot calls resumeAll(); shutdown calls stop(). */
    eraser,
    /** The advisory-lock pool of the eraser; shutdown ends it after the eraser stops. Absent without options.erasure. */
    erasureLocks,
    /** Stops feeding the models; shutdown calls it before `status.close()` and `activity.close()` so a late event is not folded onto closing pools. */
    detachStatusFeed: () => {
      feed.sinks = [];
    },
  };
}
