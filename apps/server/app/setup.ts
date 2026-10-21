import { removeStaleTemp } from "@docmind/blob-store";
import { PostgresKeyStore, loadKeks } from "@docmind/keystore-pg";
import { loadPort } from "./boot";
import { createChatLlm } from "./chats/llm";
import { loadChatSettings } from "./chats/settings";
import { buildServer } from "./compose";
import { MigrationChecksumError, verifyMigrationChecksums } from "./db/migrate";
import { createAppPool } from "./db/pool";
import { loadBlobRoot, loadLimits } from "./documents/limits";
import { createTitleLlm } from "./flows/chat-title/llm";
import { createIngestWiring, insecureBaseUrlWarning } from "./flows/ingest-document/limits";
import { parsePublicOrigin } from "./http/originGuard";
import { loadMaxConnections } from "./server";
import { StartupConfigError } from "./startupError";
import { pgStatusReaderFor, pgStatusWriter } from "./status/pgStores";
import { openDurableStorage } from "./storage";

const HOUR_MS = 60 * 60 * 1000;
// Uploads older than this that never finished are leftovers of a crash.
const STALE_TEMP_MS = HOUR_MS;

/**
 * Everything `main` and the backfill script do before they boot: configuration (every error names the
 * variable, never its value), the migration checksum check, the Loom role check, the durable stores and
 * the server's parts. Nothing listens; `bootIngest` takes it from here.
 */
export async function setupServer() {
  // Configuration first, so a missing or invalid variable fails before any connection opens. The
  // errors name the variable and never include its value.
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl)
    throw new StartupConfigError("DATABASE_URL is not set (the docmind_app connection string)");
  const loomUrl = process.env.LOOM_DATABASE_URL;
  if (!loomUrl)
    throw new StartupConfigError(
      "LOOM_DATABASE_URL is not set (the docmind_loom connection string)",
    );
  const port = loadPort(); // before anything else opens: a bad PORT must not reach recovery
  const host = process.env.HOST ?? "127.0.0.1";
  const keks = loadKeks();
  const limits = loadLimits();
  const blobRoot = loadBlobRoot();
  const publicOrigin = parsePublicOrigin(process.env.DOCMIND_PUBLIC_ORIGIN);
  const maxConnections = loadMaxConnections(); // before anything opens
  const ingest = createIngestWiring(); // validates the DOCMIND_PARSE_* and DOCMIND_OLLAMA_URL / DOCMIND_EMBED_* variables before any connection opens
  if (!ingest.llm.summary)
    console.warn("summaries and image reading are off: ANTHROPIC_API_KEY is not set");
  const chatSettings = loadChatSettings(); // before any connection opens: a bad variable must not reach recovery
  const chatLlm = createChatLlm(process.env, chatSettings);
  const titleLlm = createTitleLlm(process.env, chatSettings);
  if (!chatLlm) console.warn("chat is off: ANTHROPIC_API_KEY is not set");
  // Once per process, for all the Anthropic providers (they share the variable); only when one was built, since
  // without a key nothing is sent. The text names the variable, never the URL.
  const insecure = insecureBaseUrlWarning(ingest.llm.config.baseUrl);
  if (insecure && (ingest.llm.summary || chatLlm || titleLlm)) console.warn(insecure);

  const pool = await createAppPool(databaseUrl);

  // Read-only: an applied migration file that was edited since refuses the start (the file name only).
  // Any other failure of the check (an old schema without the grant) is logged by class, not fatal.
  try {
    await verifyMigrationChecksums(pool);
  } catch (err) {
    if (err instanceof MigrationChecksumError) {
      await pool.end();
      throw new StartupConfigError(err.message);
    }
    // Cannot verify (e.g. booted before db:migrate granted 0017): boot on, but say so with the code.
    const code = (err as { code?: unknown } | null)?.code;
    console.error(
      "migration checksum verification skipped",
      err instanceof Error ? err.constructor.name : typeof err,
      typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : "",
    );
  }

  // Loom's stores connect as docmind_loom; check that role is unprivileged too before they start.
  try {
    await (await createAppPool(loomUrl)).end();
  } catch (err) {
    await pool.end();
    // The driver's message can carry a host or user name: log the class, name the variable.
    console.error(
      "loom database check failed",
      err instanceof Error ? err.constructor.name : typeof err,
    );
    throw new StartupConfigError(
      "LOOM_DATABASE_URL must connect as an unprivileged role (docmind_loom)",
    );
  }

  const keys = new PostgresKeyStore(pool, keks);
  // A crash can leave half-written uploads behind; they are never referenced, so just clear them.
  // The error may carry a path, so only its class is logged, and the server still starts.
  await removeStaleTemp(blobRoot, STALE_TEMP_MS).catch((err: unknown) =>
    console.error(
      "stale temp cleanup failed",
      err instanceof Error ? err.constructor.name : typeof err,
    ),
  );
  let durable: Awaited<ReturnType<typeof openDurableStorage>>;
  try {
    durable = await openDurableStorage({ loomUrl, keys });
  } catch (err) {
    await pool.end();
    throw err;
  }
  // The flows are static modules; the ingest step gets its database access as a registered effect.
  const built = buildServer({
    pool,
    keys,
    storage: durable.storage,
    crypto: durable.crypto,
    erasure: { raw: durable.raw },
    limits,
    blobRoot,
    secureCookies: process.env.DOCMIND_COOKIE_SECURE === "true",
    trustProxy: process.env.DOCMIND_TRUST_PROXY === "true",
    publicOrigin,
    maxConnections,
    ingest,
    chat: {
      settings: chatSettings,
      ...(chatLlm && { llm: chatLlm }),
      ...(titleLlm && { titleLlm }),
      timers: durable.timers,
    },
    // The status writer shares the Loom pool; the reader is the app pool (every read inside withTenant).
    status: {
      writer: pgStatusWriter(durable.pool),
      readerFor: pgStatusReaderFor(pool),
      source: durable.storage.eventStore,
    },
  });
  return { built, ingest, durable, pool, port, host };
}
