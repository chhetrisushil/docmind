import type { Server } from "node:http";
import { StartupConfigError } from "./startupError";

/** PORT (default 3000), validated before any connection opens. The error names the variable, never the value. */
export function loadPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PORT?.trim();
  const port = raw ? Number(raw) : 3000;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new StartupConfigError("PORT must be an integer between 0 and 65535");
  }
  return port;
}

/** Resolves once the server is listening; rejects on a listen error (EADDRINUSE, EACCES, ...). */
export function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

/**
 * Binds first, then starts the background work that spends recovery budget. A bad bind must not cost
 * in-flight documents a recovery attempt (each re-drive records one), so nothing in `afterListen` runs
 * unless `bind` succeeded; when it fails, `cleanup` runs and the error propagates to the normal
 * startup-failure path (class-only log, non-zero exit).
 */
export async function bootServing(steps: {
  bind: () => Promise<void>;
  afterListen: () => void;
  cleanup: () => Promise<unknown>;
}): Promise<void> {
  try {
    await steps.bind();
  } catch (err) {
    await steps.cleanup().catch(() => undefined);
    throw err;
  }
  steps.afterListen();
}
