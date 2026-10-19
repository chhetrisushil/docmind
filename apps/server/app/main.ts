import { primeDecoy } from "@docmind/auth";
import { removeStaleTemp } from "@docmind/blob-store";
import { PostgresKeyStore, loadKeks } from "@docmind/keystore-pg";
import { buildServer } from "./compose";
import { createAppPool } from "./db/pool";
import { loadBlobRoot, loadLimits } from "./documents/limits";
import { createIngestWiring } from "./flows/ingest-document/limits";
import { shutdown } from "./shutdown";
import { openDurableStorage } from "./storage";

const HOUR_MS = 60 * 60 * 1000;
// Uploads older than this that never finished are leftovers of a crash.
const STALE_TEMP_MS = HOUR_MS;

async function main(): Promise<void> {
  // Configuration first, so a missing or invalid variable fails before any connection opens. The
  // errors name the variable and never include its value.
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is not set (the docmind_app connection string)");
  const loomUrl = process.env.LOOM_DATABASE_URL;
  if (!loomUrl)
    throw new Error("LOOM_DATABASE_URL is not set (the docmind_loom connection string)");
  const keks = loadKeks();
  const limits = loadLimits();
  const blobRoot = loadBlobRoot();
  const ingest = createIngestWiring(); // validates the DOCMIND_PARSE_* variables before any connection opens

  const pool = await createAppPool(databaseUrl);

  // Loom's stores connect as docmind_loom; check that role is unprivileged too before they start.
  try {
    await (await createAppPool(loomUrl)).end();
  } catch (err) {
    await pool.end();
    throw new Error(`LOOM_DATABASE_URL: ${err instanceof Error ? err.message : String(err)}`);
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
  const { app, server, store, throttle, starts } = buildServer({
    pool,
    keys,
    storage: durable.storage,
    crypto: durable.crypto,
    limits,
    blobRoot,
    secureCookies: process.env.DOCMIND_COOKIE_SECURE === "true",
    trustProxy: process.env.DOCMIND_TRUST_PROXY === "true",
    ingest,
  });

  const sweep = () =>
    Promise.all([store.purgeExpiredSessions(), throttle.purge()]).catch((err) =>
      console.error(err),
    );
  void sweep();
  const sweepTimer = setInterval(sweep, HOUR_MS);
  sweepTimer.unref();

  // Hash the decoy now so the first unknown-email login is not measurably slower.
  await primeDecoy();

  const rawPort = process.env.PORT?.trim();
  const port = rawPort ? Number(rawPort) : 3000;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("PORT must be an integer between 0 and 65535");
  }
  const host = process.env.HOST ?? "127.0.0.1";
  server.listen(port, host, () =>
    console.log(`docmind server listening on http://${host}:${port}`),
  );

  // One shutdown, shared by every signal: a second signal reuses the same promise instead of
  // calling server.close() again, which would reject with ERR_SERVER_NOT_RUNNING. The server
  // drains first; then the app closes (which closes the Loom stores), then the Loom pool, then
  // the pool the key store reads from.
  let closing: Promise<void> | undefined;
  const stop = () => {
    clearInterval(sweepTimer);
    closing ??= shutdown(server, {
      close: async () => {
        // The server has stopped accepting uploads; let every fired flow start settle before Loom closes.
        await starts.idle();
        await app.close();
        await durable.close();
        await pool.end();
      },
    }).catch((err) => {
      console.error(err);
      process.exitCode = 1;
    });
  };

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, stop);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
