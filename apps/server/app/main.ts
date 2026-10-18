import { AuthService, PasswordAuthenticator, primeDecoy } from "@docmind/auth";
import { PgAuthStore } from "./auth/pgAuthStore";
import { PgThrottle } from "./auth/pgThrottle";
import { authRoutes } from "./auth/routes";
import { app } from "./config";
import { createAppPool } from "./db/pool";
import { createHttpServer } from "./server";
import { shutdown } from "./shutdown";

const HOUR_MS = 60 * 60 * 1000;

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is not set (the docmind_app connection string)");
  const pool = await createAppPool(databaseUrl);

  const store = new PgAuthStore(pool);
  const throttle = new PgThrottle(pool);
  const server = createHttpServer(
    authRoutes({
      service: new AuthService(store),
      authenticator: new PasswordAuthenticator(store),
      store,
      throttle,
      secureCookies: process.env.DOCMIND_COOKIE_SECURE === "true",
      trustProxy: process.env.DOCMIND_TRUST_PROXY === "true",
    }),
  );

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
  // drains first; the app closes before the pool it may read from.
  let closing: Promise<void> | undefined;
  const stop = () => {
    clearInterval(sweepTimer);
    closing ??= shutdown(server, {
      close: async () => {
        await app.close();
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
