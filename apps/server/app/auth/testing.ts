import type { AddressInfo } from "node:net";
import { AuthService, PasswordAuthenticator } from "@docmind/auth";
import { MemoryAuthStore, MemoryThrottle } from "@docmind/auth/testing";
import { afterEach } from "vitest";
import type { AccountErasure } from "../erasure/account";
import { createHttpServer } from "../server";
import { authRoutes } from "./routes";

type Server = ReturnType<typeof createHttpServer>;

/**
 * The one HTTP test scaffold of the auth and erasure route tests: register it at the top of a test file, and every
 * server it listens on is closed after each test. Returns the server's base URL.
 */
export function useServers(): (server: Server) => Promise<string> {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
  });
  return async (server) => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    closers.push(
      () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    );
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };
}

/** The real server over in-memory auth, with a frozen throttle clock; `erasure` is optional like in production. */
export async function serveMemoryAuth(
  serve: (server: Server) => Promise<string>,
  erasure?: AccountErasure,
) {
  const store = new MemoryAuthStore();
  const throttle = new MemoryThrottle();
  throttle.now = () => 1_000_000;
  const service = new AuthService(store);
  const base = await serve(
    createHttpServer(
      authRoutes({
        service,
        authenticator: new PasswordAuthenticator(store),
        store,
        throttle,
        secureCookies: false,
        trustProxy: false,
        ...(erasure && { erasure }),
      }),
    ),
  );
  return { base, service, store, throttle };
}
