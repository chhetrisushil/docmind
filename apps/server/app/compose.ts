import { randomBytes } from "node:crypto";
import { AuthService, type Identity, PasswordAuthenticator } from "@docmind/auth";
import { EncryptedFsContentStore } from "@docmind/blob-store";
import { createViews } from "@docmind/experiences";
import { type ChunkVectorStore, PgChunkVectorStore } from "@docmind/vector-pg";
import type { PrincipalCryptoOptions, StorageConfig } from "@loom/app";
import {
  type TurnSettledEvent,
  createConversationReader,
  turnSettledObserver,
} from "@loom/conversation";
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
import { PgChatIds } from "./chats/chatIds";
import { CHAT_FLOW_ID, CHAT_GK_FLOW_ID } from "./chats/ids";
import type { ChatLlm } from "./chats/llm";
import { pgCollaborators } from "./chats/pgCollaborators";
import { replyReasoning } from "./chats/reasoningRead";
import { chatRoutes } from "./chats/routes";
import type { ChatSettings } from "./chats/settings";
import { chatStreamRoutes } from "./chats/stream";
import { lineageTurnHeads } from "./chats/turnHeads";
import { connectChat, prepareChat } from "./chats/wiring";
import { buildApp } from "./config";
import { FieldCrypto } from "./crypto/fields";
import { TagKeys } from "./crypto/tagKeys";
import { withTenant } from "./db/tenant";
import { documentEventRoutes } from "./documents/events";
import { PgExecutionRecorder } from "./documents/executionIds";
import { type IngestPort, loomIngest } from "./documents/ingest";
import type { DocumentLimits } from "./documents/limits";
import { documentRoutes } from "./documents/routes";
import { StartScheduler } from "./documents/startScheduler";
import { pgAccountErasure } from "./erasure/account";
import type { ErasureWiring } from "./erasure/compliance";
import type { ControlStreamKeys } from "./erasure/controlKey";
import { ERASURE_CONCURRENCY, Eraser, type ErasureDeps } from "./erasure/eraser";
import { pgErasureSql } from "./erasure/pgSteps";
import { PgErasureStore } from "./erasure/pgStore";
import { tolerantSource } from "./erasure/tolerantSource";
import { erasureDeps, requireKeyDestroyedProof } from "./erasure/wire";
import { loomTitleStarter } from "./flows/chat-title/start";
import type { IngestWiring } from "./flows/ingest-document/limits";
import { PgChunkStore } from "./flows/ingest-document/pgChunks";
import { pgIngestDeps } from "./flows/ingest-document/pgDeps";
import { loomSuggestTagsStarter } from "./flows/suggest-tags/start";
import { newVisualizeGate } from "./flows/visualize-document/deps";
import { visualizeDocumentFlow } from "./flows/visualize-document/flow";
import { visualsLineage } from "./flows/visualize-document/lineage";
import { PgVisualFacts } from "./flows/visualize-document/pgFacts";
import { PgVisualizeGuard } from "./flows/visualize-document/pgGuard";
import { PgStructureReader } from "./flows/visualize-document/pgStructure";
import { visualsPlanner } from "./flows/visualize-document/planner";
import { PgVisualRuns, visualRunRecorder } from "./flows/visualize-document/runs";
import {
  hasVisualsHead,
  loomVisualsStarter,
  pgReadyDocuments,
  pgRetryDocuments,
  pgRunningRuns,
  pgStaleFormatDocuments,
  pgUnrecordedDocuments,
} from "./flows/visualize-document/start";
import { visualsStateReader } from "./flows/visualize-document/state";
import { visualizeTurnFlow } from "./flows/visualize-turn/flow";
import { PgTurnGuard } from "./flows/visualize-turn/guard";
import type { TurnRef } from "./flows/visualize-turn/ids";
import { UserRateLimit } from "./flows/visualize-turn/limiter";
import { PgTurnVisualFacts } from "./flows/visualize-turn/pgTurnFacts";
import { readTurn } from "./flows/visualize-turn/readTurn";
import { loomTurnStarter } from "./flows/visualize-turn/start";
import { MAX_WAITING } from "./flows/visualize-turn/trigger";
import { READY_PING_TIMEOUT_MS, createReadiness } from "./http/readiness";
import { staticHandler } from "./http/staticFiles";
import { composeDurableObservers } from "./observers";
import { OpaqueIds, opaqueIds } from "./opaqueIds";
import { PgHandleStore } from "./opaqueIds/pgHandles";
import { createHttpServer } from "./server";
import { StartupConfigError } from "./startupError";
import type { UserExecutionLister } from "./status/forgetUser";
import { type DocumentStatusReads, IngestStatus } from "./status/ingestStatus";
import { flowSteps, statusSensitive } from "./status/wire";
import { sealedLineageContent } from "./storage";
import { PgContentStore } from "./storage/pgContentStore";
import { subjectOfExecution } from "./subject";
import { tagRoutes } from "./tags/routes";
import { TagService } from "./tags/service";
import { suggestRoutes } from "./tags/suggestRoutes";
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
    /** The keys of Loom's erasure control stream, derived from the KEKs (`controlKey.ts`): rows there carry a keyed digest, never a subject id. */
    controlStreamKeys: ControlStreamKeys;
    loomPool: Pool;
    wrap?: (deps: ErasureDeps) => ErasureDeps;
    sleep?: ErasureDeps["sleep"];
  };
  /** The docmind_app pool: auth, documents and the ingest step read through it. */
  pool: Pool;
  keys: KeyStore;
  /** Test seam: the id cache (default: one over `keys` and a `PgHandleStore` on `pool`; a test with a stub pool passes its own). */
  ids?: OpaqueIds;
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
  /**
   * R19: the deployment secret that keys the visuals planner's decision ids (`DOCMIND_PLANNER_DECISION_KEY`, decoded).
   * Required while the `visuals` role is on: composing refuses without it.
   */
  plannerDecisionKey?: Uint8Array;
  /** M4 chat: the settings, the chat LLM provider (absent when chat is off) and the timer store. Absent: no chat (the CLI, most tests). */
  chat?: {
    settings: ChatSettings;
    llm?: ChatLlm;
    titleLlm?: LlmProvider;
    timers: TimerStore;
    /** Test seams passed to `prepareChat`: how many turns make a generation, and a server from before the rolling summary. */
    rotateEveryTurns?: number;
    legacyOnly?: boolean;
  };
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
  // The id module (R14): the per-user key cache and the handle store. Installed process-wide so the synchronous parsers (the status fold, the
  // stores' subject mapping) can read new-format ids; `bootIngest` warms it before anything runs. `executions` records each document's current ids.
  const ids = options.ids ?? new OpaqueIds(keys, new PgHandleStore(pool));
  const chatIds = new PgChatIds(pool, ids);
  opaqueIds.install(ids);
  // Each document's current ingest and visualize execution ids (migration 0038), which the boot sweeps and the connections reader compare with the status rows.
  const executions = new PgExecutionRecorder(pool);
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
        ...(options.chat.rotateEveryTurns !== undefined && {
          rotateEveryTurns: options.chat.rotateEveryTurns,
        }),
        ...(options.chat.legacyOnly && { legacyOnly: true }),
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
  // The visuals flow. Its lineage lives over the SEALED content store only (`visualsLineage` refuses any other) and the
  // sealing event store; the planner calls the visuals provider directly, so its prompt (the facts) writes no event.
  const rawLineageContent = new PgContentStore(pool);
  const lineageContent = sealedLineageContent(rawLineageContent, keys);
  const visualsLlm = options.ingest.llm.visuals;
  if (visualsLlm && !options.plannerDecisionKey)
    throw new StartupConfigError(
      "DOCMIND_PLANNER_DECISION_KEY is not set (required while the visuals role is on)",
    );
  const planner =
    visualsLlm && options.plannerDecisionKey
      ? visualsPlanner(visualsLlm, options.plannerDecisionKey)
      : undefined;
  const visualsLineageOf = visualsLineage({
    events: options.status.source,
    content: lineageContent,
    keys,
    subjectOf: subjectOfExecution,
  });
  // Read-only, so it serves whenever chat is on: a deployment that turned the visuals role off still shows earlier visuals.
  // Not free: `hasVisuals` loads and unseals each head (`resolveLatest`), at most 30 per history page, 8 in flight (chats/turnHeads.ts).
  const heads = lineageTurnHeads(visualsLineageOf, chatIds);
  // Visuals never share ingest's gate: one slot per tenant, so an ingest step never queues behind a visualize step.
  const visualizeGate = newVisualizeGate();
  const visualRuns = new PgVisualRuns(pool);
  const tags = new TagService(pool, fields, new TagKeys(keys));
  const afterDone = new Set<string>();
  const reextract = new Set<string>(); // re-runs the user asked for: the extract step extracts again when the stored extraction predates c2
  const legacyRuns = new Set<string>(); // executions the 1.0.0 flow ran: the recorder does not stamp them current
  const visualize = {
    flow: visualizeDocumentFlow(() => planner),
    legacyFlow: visualizeDocumentFlow(() => planner, { legacy: true, legacyRuns }),
    deps: {
      guard: new PgVisualizeGuard(pool),
      chunks: new PgChunkStore(pool, fields),
      facts: new PgVisualFacts(pool, fields),
      structure: new PgStructureReader(pool, fields),
      summaryMaxChars: options.ingest.summaryMaxChars,
      lineage: visualsLineageOf,
      ids,
      bus: options.ingest.bus,
      now: () => new Date().toISOString(),
      shutdown: options.ingest.shutdown.signal,
      gate: visualizeGate,
      runs: visualRuns,
      afterDone,
      reextract,
      ...(options.ingest.sleep && { sleep: options.ingest.sleep }),
      ...(visualsLlm && { llm: visualsLlm }),
      // The document extraction's own provider: a longer answer cap and timeout than the planner's and chat's.
      ...(options.ingest.llm.visualsExtract && { extractLlm: options.ingest.llm.visualsExtract }),
      ...(planner && { planner }),
    },
  };
  // The turn-settled hook needs the runtime that buildApp creates, so the observer is late-bound (as `statusReads` is).
  let settled: ((e: EventEnvelope) => void) | undefined;
  const turnRead = chatParts && {
    read: (ref: TurnRef, signal?: AbortSignal) =>
      readTurn(
        {
          reader: createConversationReader(options.status.source),
          items: chatParts.collaborators.items,
          pool,
          fields,
          chatIds,
        },
        ref,
        signal,
      ),
  };
  const visualizeTurn = chatParts &&
    turnRead && {
      flow: visualizeTurnFlow(() => planner),
      deps: {
        guard: new PgTurnGuard(pool),
        turn: turnRead,
        stored: new PgVisualFacts(pool, fields),
        turnFacts: new PgTurnVisualFacts(pool, fields),
        passages: chatParts.collaborators.passages,
        summaryMaxChars: options.ingest.summaryMaxChars,
        lineage: visualsLineageOf, // sealed (visualsLineage fails closed without a sealing content store)
        bus: chatParts.bus,
        chatIds,
        now: () => new Date().toISOString(),
        shutdown: options.ingest.shutdown.signal,
        gate: visualizeGate, // the SAME gate as visualize-document: at most 2 visuals executions in flight
        ...(options.ingest.sleep && { sleep: options.ingest.sleep }),
        ...(visualsLlm && { llm: visualsLlm }),
        ...(planner && { planner }),
      },
    };
  const app = buildApp(options.storage, options.crypto, {
    ingest: pgIngestDeps({ pool, fields, keys, blobs, wiring: options.ingest, vectors }),
    visualize,
    ...(visualizeTurn && { visualizeTurn }),
    onDurableEvent: (e) => settled?.(e),
    ...(chatParts && { chat: chatParts.deps }),
    ...(options.chat && {
      chatTitle: {
        pool,
        fields,
        chatIds,
        reader: createConversationReader(options.status.source), // a reader is only the decrypting event store
        ...(titleLlm && { llm: titleLlm }),
      },
    }),
    suggestTags: {
      pool,
      fields,
      tags,
      bus: options.ingest.bus,
      ...(options.ingest.llm.summary && { llm: options.ingest.llm.summary }),
    },
    ...(options.erasure && {
      erasure: {
        keys,
        raw: options.erasure.raw,
        controlStreamKeys: options.erasure.controlStreamKeys,
      },
    }),
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
  const titles = options.chat && loomTitleStarter(app.runtime, chatIds);
  // On-demand tag suggestions: one flow, one model call; off with the `summary` role.
  const suggestTags = loomSuggestTagsStarter(app.runtime, {
    ids,
    enabled: () => options.ingest.llm.summary !== undefined,
  });
  const visuals = loomVisualsStarter(app.runtime, visualize.flow, {
    ids,
    executions,
    ready: pgReadyDocuments(pool),
    retry: pgRetryDocuments(pool),
    stale: pgStaleFormatDocuments(pool),
    unrecorded: pgUnrecordedDocuments(pool),
    visualized: hasVisualsHead(visualsLineageOf, ids),
    running: pgRunningRuns(pool),
    runs: visualRuns,
    afterDone,
    reextract,
    enabled: visualsLlm !== undefined,
  });
  const turns =
    visualizeTurn &&
    turnRead &&
    loomTurnStarter(app.runtime, visualizeTurn.flow, {
      enabled: () => visualsLlm !== undefined,
      tenantOf: async (userId, chatId) =>
        ((
          await pool.query("SELECT public.docmind_chat_tenant($1::uuid, $2::uuid) AS t", [
            chatId,
            userId,
          ])
        ).rows[0]?.t as string | null) ?? null,
      turn: turnRead,
      chatIds,
      backlog: () => visualizeGate.waiting,
      maxWaiting: MAX_WAITING,
    });
  if (turns) {
    const onSettled = (e: TurnSettledEvent) => turns.onSettled(e);
    // One onDurableEvent per runtime: one observer per chat flow, composed here so later observers compose here too.
    settled = composeDurableObservers(
      turnSettledObserver({ definition: { id: CHAT_FLOW_ID } }, onSettled),
      turnSettledObserver({ definition: { id: CHAT_GK_FLOW_ID } }, onSettled),
    );
  }
  const chat = chatParts && connectChat(chatParts, app.runtime, options.status.source);
  const sensitive = statusSensitive(flowSteps(), options.status.source);
  // The models fold through a source that reads an erased user's log as placeholders instead of throwing (E5). The
  // runtime, the chat reads and every authoritative read keep the strict `options.status.source`.
  // Catch-up and rebuild read the stored form here, not through the summary-choice decorator (live folds see the
  // string): the chat-activity fold ignores the summary-fit decision either way (not a conversation record).
  const foldSource = options.erasure
    ? tolerantSource({ raw: options.erasure.raw.eventStore, keys, strict: options.status.source })
    : options.status.source;
  const status = new IngestStatus({
    writer: options.status.writer,
    readerFor: options.status.readerFor,
    source: foldSource,
    sensitive,
    bus: options.ingest.bus,
    // A document whose ingest turned ready is visualized (once per generation; the boot sweep covers a missed event).
    onReady: (ref, generation) => visuals.fire(ref, generation),
    ...(options.status.userExecutions && { userExecutions: options.status.userExecutions }),
  });
  const activity = new ChatActivity({
    writer: options.status.writer,
    source: foldSource,
    sensitive,
    ...(options.status.userExecutions && { userExecutions: options.status.userExecutions }),
  });
  // The end of a visualize execution is recorded (the detail page's `visuals.state`, the boot sweep's re-run source) and a
  // failed one tells the owner's open pages.
  const visualRecorder = visualRunRecorder({
    runs: visualRuns,
    bus: options.ingest.bus,
    legacyRuns,
    onEnded: (executionId) => visuals.ended(executionId),
  });
  feed.sinks = [status.onEvent, activity.onEvent, visualRecorder.onEvent];
  const ingest = options.wrapIngest
    ? options.wrapIngest(loomIngest(app.runtime, { ids, executions }))
    : loomIngest(app.runtime, { ids, executions });
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
      chatIds,
      reasoning,
      heads,
      visualsOn: visualsLlm !== undefined,
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
              ids,
              chatIds,
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
              visuals,
              suggestTags,
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
  // The probe pings over a connection of its own (same settings as the app pool, one client): on the shared
  // pool it would queue behind requests under load and report the database down while it is healthy.
  // `stop()` flips it; the close sequence ends this pool. A pool opens no connection until the first probe.
  const readyPool = new Pool({
    ...pool.options,
    max: 1,
    connectionTimeoutMillis: READY_PING_TIMEOUT_MS,
  });
  readyPool.on("error", (err) =>
    console.error(
      "idle readiness database connection failed",
      err instanceof Error ? err.constructor.name : typeof err,
    ),
  );
  const readiness = createReadiness({
    // node-postgres honours `query_timeout` per query but its typings omit it; the cap frees the connection from a hung database.
    ping: async () => {
      await readyPool.query({
        text: "SELECT 1",
        query_timeout: READY_PING_TIMEOUT_MS,
      } as QueryConfig);
    },
    closePing: () => readyPool.end(),
  });
  const server = createHttpServer(
    {
      "GET /readyz": readiness.handler,
      "HEAD /readyz": readiness.handler,
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
        visuals,
        // Its own limiter (10 per user per minute): a document's retry and a chat's visualize are different resources, and
        // a shared window would let clicks on one starve the other.
        visualize: { starter: visuals, limiter: new UserRateLimit() },
        starts,
        status,
        tags,
      }),
      ...tagRoutes({ authenticator, tags }),
      ...suggestRoutes({
        pool,
        authenticator,
        tags,
        starter: suggestTags,
        limiter: new UserRateLimit(),
      }),
      ...uiRoutes({
        authenticator,
        views,
        lineage: visualsLineageOf,
        ids,
        chatIds,
        visualsState: visualsStateReader({ pool, runs: visualRuns, starter: visuals }),
        readers: {
          pool,
          fields,
          status,
          tags,
          blobs,
          registry: options.ingest.registry,
          visualFacts: new PgVisualFacts(pool, fields),
          turnFacts: new PgTurnVisualFacts(pool, fields),
        },
      }),
      ...(chat &&
        reasoning &&
        chatRoutes({
          pool,
          authenticator,
          fields,
          chat,
          eventStore: options.status.source,
          chatIds,
          reasoning,
          heads,
          visualsOn: visualsLlm !== undefined,
          ...(titleLlm && titles && { titles }),
          ...(turns &&
            turnRead && {
              visualize: { starter: turns, turn: turnRead, limiter: new UserRateLimit() },
            }),
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
    /** The id cache (installed process-wide): `bootIngest` warms it before the status model boots; tests build ids with it. */
    ids,
    /** Builds a chat's Loom ids in the chat's own format (migration 0039). */
    chatIds,
    /**
     * The visuals lineage's artifact store: Postgres under the per-user sealing wrapper, built once. Task 9 builds
     * `visualsLineage` over this; the raw `PgContentStore` is never exposed, so a `Lineage` cannot be built over plaintext.
     */
    lineageContent,
    /**
     * What the lineage content collector needs (`storage/pgLineageGc.ts`): THE visuals `Lineage` (all lines) and the raw
     * store under the sealing wrapper, which alone has the sweep set. Not for any reader or writer of blobs.
     */
    lineageGc: { lineage: visualsLineageOf, store: rawLineageContent },
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
    /** The tag service; the erasure end-to-end seed writes a suggestion through it. */
    tags,
    /** The chat wiring; absent when `options.chat` is. Its routes are mounted from `chatRoutes`. */
    chat,
    /** Starts a chat's auto title; absent when `options.chat` is. `idle()` is awaited at shutdown with the ingest starts. */
    titles,
    /** Starts visualize-turn runs; absent without chat. idle() is awaited at shutdown with the other starts. */
    turns,
    /** Starts the on-demand tag suggestions; shutdown awaits `idle()` with the other starts. */
    suggestTags,
    /** Starts, sweeps and cancels the visualize flow; boot calls `sweep()`, shutdown awaits `idle()`. */
    visuals,
    /** True while the `visuals` role is on (the lineage collector runs only then). */
    visualsOn: visualsLlm !== undefined,
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
