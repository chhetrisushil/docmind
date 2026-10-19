import type { AddressInfo } from "node:net";
import { AuthService, POLICIES, PasswordAuthenticator } from "@docmind/auth";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, setAppRolePassword } from "../db/migrate";
import { APP_PASSWORD, PG_URL, type TestDb, createTestDb } from "../db/testSupport";
import { createHttpServer } from "../server";
import { PgAuthStore } from "./pgAuthStore";
import { PgThrottle } from "./pgThrottle";
import { authRoutes } from "./routes";

const PASSWORD = "correct horse battery";

describe.skipIf(!PG_URL)("auth routes on Postgres (needs DOCMIND_TEST_PG_URL)", () => {
  let db: TestDb;
  let app: Pool;
  let server: ReturnType<typeof createHttpServer>;
  let base: string;

  beforeAll(async () => {
    db = await createTestDb();
    await migrate(db.owner);
    await setAppRolePassword(db.owner, APP_PASSWORD);
    app = new Pool({ connectionString: db.appUrl });
    const store = new PgAuthStore(app);
    server = createHttpServer(
      authRoutes({
        service: new AuthService(store),
        authenticator: new PasswordAuthenticator(store),
        store,
        throttle: new PgThrottle(app),
        secureCookies: false,
        trustProxy: false,
      }),
    );
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
    await app?.end();
    await db?.drop();
  });

  const post = (path: string, body: unknown, cookie?: string) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    });

  it("signs up, logs in, reads /api/me, and logs out", async () => {
    const email = "ada@example.com";
    const first = await post("/api/auth/sign-up", { email, password: PASSWORD });
    expect(first.status).toBe(202);
    const firstBody = await first.text();
    const again = await post("/api/auth/sign-up", { email, password: PASSWORD });
    expect(again.status).toBe(202);
    expect(await again.text()).toBe(firstBody);

    const login = await post("/api/auth/login", { email, password: PASSWORD });
    expect(login.status).toBe(200);
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    expect(cookie).not.toBe("");

    const me = await fetch(`${base}/api/me`, { headers: { cookie } });
    expect(me.status).toBe(200);
    expect(((await me.json()) as { email: string }).email).toBe(email);

    expect((await post("/api/auth/logout", {}, cookie)).status).toBe(204);
    expect((await fetch(`${base}/api/me`, { headers: { cookie } })).status).toBe(401);
  });

  it("lets at most the free budget of a concurrent wrong-password burst reach a 401", async () => {
    const email = "burst@example.com";
    expect((await post("/api/auth/sign-up", { email, password: PASSWORD })).status).toBe(202);
    const wrong = () => post("/api/auth/login", { email, password: "wrong password!" });
    // The first attempt runs alone, so one 401 is certain. In a fully concurrent burst the attempts
    // that count past the free budget can lock the account before the first ones check it, and
    // every request then reads a lock (all 429, no 401), which made `rejected > 0` flaky.
    const first = await wrong();
    const burst = [first, ...(await Promise.all(Array.from({ length: 14 }, wrong)))];
    const statuses = burst.map((res) => res.status);
    const rejected = statuses.filter((s) => s === 401).length;
    expect(rejected).toBeGreaterThan(0);
    expect(rejected).toBeLessThanOrEqual(POLICIES.loginAccount.free);
    expect(statuses.every((s) => s === 401 || s === 429)).toBe(true);
    expect(statuses.filter((s) => s === 429).length).toBe(15 - rejected);
  });
});
