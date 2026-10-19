import { randomUUID } from "node:crypto";
import { primeDecoy } from "@docmind/auth";
import { removeStaleTemp } from "@docmind/blob-store";
import { PostgresKeyStore, loadKeks } from "@docmind/keystore-pg";
import { closeSequence } from "./closeSequence";
import { buildServer } from "./compose";
import { createAppPool } from "./db/pool";
import { loadBlobRoot, loadLimits } from "./documents/limits";
import { STALE_UPLOAD_MS, SWEEP_BATCH, SWEEP_LOOKBACK_MS } from "./documents/sweep";
import { startSweeper } from "./documents/sweeper";
import { closeIngest, createIngestWiring } from "./flows/ingest-document/limits";
import { startRecovery } from "./flows/ingest-document/recovery";
import { verifyVectors } from "./flows/ingest-document/verifyVectors";
import { SHUTDOWN_DRAIN_MS, drainWithin, runAll, scheduleForceExit, shutdown } from "./shutdown";
import { StartupConfigError, reportStartupFailure } from "./startupError";
import { bootStatus } from "./status/boot";
import { pgStatusReaderFor, pgStatusWriter } from "./status/pgStores";
import { openDurableStorage } from "./storage";

const HOUR_MS = 60 * 60 * 1000;
// Uploads older than this that never finished are leftovers of a crash.
const STALE_TEMP_MS = HOUR_MS;

async function main(): Promise<void> {
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
  const keks = loadKeks();
  const limits = loadLimits();
  const blobRoot = loadBlobRoot();
  const ingest = createIngestWiring(); // validates the DOCMIND_PARSE_* and DOCMIND_OLLAMA_URL / DOCMIND_EMBED_* variables before any connection opens

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
  const { app, server, store, throttle, starts, status, vectors, events, detachStatusFeed } =
    buildServer({
      pool,
      keys,
      storage: durable.storage,
      crypto: durable.crypto,
      limits,
      blobRoot,
      secureCookies: process.env.DOCMIND_COOKIE_SECURE === "true",
      trustProxy: process.env.DOCMIND_TRUST_PROXY === "true",
      ingest,
      // The status writer shares the Loom pool; the reader is the app pool (every read inside withTenant).
      status: {
        writer: pgStatusWriter(durable.pool),
        readerFor: pgStatusReaderFor(pool),
        source: durable.storage.eventStore,
      },
    });

  // The schema (applied out of band by `pnpm db:migrate`) must fit the embedder before anything else
  // starts. The embedder holds no resources, so closeIngest (the runner) covers its share.
  await verifyVectors(vectors, [
    () => closeIngest(ingest),
    () => app.close(),
    () => durable.close(),
    () => pool.end(),
  ]);

  // Boot order (ADR 0132 D13): register, then catch up on what the log holds, before anything is served.
  await bootStatus(status, [
    () => closeIngest(ingest),
    () => app.close(),
    () => durable.close(),
    () => pool.end(),
  ]);

  // Resume what the last process left running (a crash, or a shutdown that released its leases), then keep
  // looking. Not awaited: a pass settles each step it re-drives, and the server must not wait to listen.
  const recovery = startRecovery(app.runtime, durable.storage.eventStore, {
    // After the boot scan, a crash is found through its expired lease, not by reading every execution.
    ...(durable.storage.leaseStore && {
      leases: { store: durable.storage.leaseStore, owner: randomUUID() },
    }),
  });

  const sweep = () =>
    Promise.all([store.purgeExpiredSessions(), throttle.purge()]).catch((err: unknown) =>
      console.error(
        "session sweep failed",
        err instanceof Error ? err.constructor.name : typeof err,
      ),
    );
  void sweep();
  const sweepTimer = setInterval(sweep, HOUR_MS);
  sweepTimer.unref();

  // Hash the decoy now so the first unknown-email login is not measurably slower.
  await primeDecoy();

  const rawPort = process.env.PORT?.trim();
  const port = rawPort ? Number(rawPort) : 3000;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new StartupConfigError("PORT must be an integer between 0 and 65535");
  }
  const host = process.env.HOST ?? "127.0.0.1";
  server.listen(port, host, () =>
    console.log(`docmind server listening on http://${host}:${port}`),
  );

  // Starts the documents whose upload committed but whose flow never started. One sweep at a time,
  // an error is logged by class and never escapes, and the timer does not keep the process alive.
  const uploadSweeper = startSweeper({
    pool,
    starts,
    status,
    olderThanMs: STALE_UPLOAD_MS,
    lookbackMs: SWEEP_LOOKBACK_MS,
    limit: SWEEP_BATCH,
  });

  // One shutdown, shared by every signal: a second signal reuses the same promise instead of
  // calling server.close() again, which would reject with ERR_SERVER_NOT_RUNNING. The server
  // drains first; then the app closes (which closes the Loom stores), then the Loom pool, then
  // the pool the key store reads from.
  let closing: Promise<void> | undefined;
  const stop = () => {
    // Timers first, then the open event streams (they never end on their own, so the server drain
    // below would wait on them until SIGKILL), then the server drain and the close sequence.
    clearInterval(sweepTimer);
    recovery.stop();
    const sweeperStopped = uploadSweeper.stop(); // idempotent; no sweep may fire a start once the drain begins
    events.closeAll();
    closing ??= shutdown(server, {
      close: async () => {
        // Let a sweep that is already running finish.
        await drainWithin(sweeperStopped, SHUTDOWN_DRAIN_MS);
        // The server has stopped accepting uploads; let every fired flow start settle (bounded: a
        // start stuck on a dead database must not keep the stores open), then close everything.
        await runAll(
          ...closeSequence({
            startsIdle: () => starts.idle(),
            closeIngest: () => closeIngest(ingest),
            closeHeartbeat: () => app.runtime.closeHeartbeat(),
            detachStatusFeed,
            closeStatus: () => status.close(),
            closeApp: () => app.close(),
            closeDurable: () => durable.close(),
            endPool: () => pool.end(),
          }),
        );
      },
    })
      .catch((err: unknown) => {
        console.error("shutdown failed", err instanceof Error ? err.constructor.name : typeof err);
        process.exitCode = 1;
      })
      .finally(() => scheduleForceExit(process.exit, () => process.exitCode));
  };

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, stop);
  }
}

main().catch((err) => {
  reportStartupFailure(err);
  process.exit(1);
});
