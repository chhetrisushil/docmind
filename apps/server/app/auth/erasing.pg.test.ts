import { AuthService, PasswordAuthenticator } from "@docmind/auth";
import { ErrorBody, SignUpResponse } from "@docmind/contracts";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, setAppRolePassword } from "../db/migrate";
import { APP_PASSWORD, PG_URL, type TestDb, createTestDb } from "../db/testSupport";
import { pgAccountErasure } from "../erasure/account";
import { PgErasureStore } from "../erasure/pgStore";
import { newReceipt } from "../erasure/receipt";
import { createHttpServer } from "../server";
import { PgAuthStore } from "./pgAuthStore";
import { PgThrottle } from "./pgThrottle";
import { authRoutes } from "./routes";
import { useServers } from "./testing";

const PASSWORD = "correct horse battery";
const NEW_PASSWORD = "another long password";

const serve = useServers();

describe.skipIf(!PG_URL)(
  "an account being erased: login is refused, the email is free (needs DOCMIND_TEST_PG_URL)",
  () => {
    let db: TestDb;
    let app: Pool;
    let base: string;

    beforeAll(async () => {
      db = await createTestDb();
      await migrate(db.owner);
      await setAppRolePassword(db.owner, APP_PASSWORD);
      app = new Pool({ connectionString: db.appUrl });
    });
    afterAll(async () => {
      await app?.end();
      await db?.drop();
    });

    // useServers() closes after each test, so each test serves its own.
    const listen = async () => {
      const store = new PgAuthStore(app);
      base = await serve(
        createHttpServer(
          authRoutes({
            service: new AuthService(store),
            authenticator: new PasswordAuthenticator(store),
            store,
            throttle: new PgThrottle(app),
            secureCookies: false,
            trustProxy: false,
          }),
        ),
      );
    };

    const post = (path: string, body: unknown) =>
      fetch(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const signUp = async (email: string) =>
      expect((await post("/api/auth/sign-up", { email, password: PASSWORD })).status).toBe(202);
    const idOf = async (email: string) =>
      (await db.owner.query("SELECT id, tenant_id FROM users WHERE email = $1", [email]))
        .rows[0] as { id: string; tenant_id: string };

    it("after the request: login cannot match the old email, the same email signs up at once as a new account, and a neighbour is unaffected", async () => {
      await listen();
      await signUp("ada@erase.test");
      await signUp("bob@erase.test");
      expect(
        (await post("/api/auth/login", { email: "ada@erase.test", password: PASSWORD })).status,
      ).toBe(200);
      const ada = await idOf("ada@erase.test");
      const oldHash = (
        await db.owner.query("SELECT password_hash FROM users WHERE id = $1", [ada.id])
      ).rows[0].password_hash;

      await pgAccountErasure({
        pool: app,
        store: new PgErasureStore(app),
        eraser: { run: async () => {} },
      }).request({ userId: ada.id, tenantId: ada.tenant_id }, newReceipt().hash);
      expect(
        (await db.owner.query("SELECT email FROM users WHERE id = $1", [ada.id])).rows[0].email,
      ).toBe(`erased:${ada.id}`);

      // Login: no account has that email any more. The answer is the one for a wrong password.
      const refused = await post("/api/auth/login", {
        email: "ada@erase.test",
        password: PASSWORD,
      });
      const wrong = await post("/api/auth/login", {
        email: "bob@erase.test",
        password: "not the password",
      });
      expect(refused.status).toBe(401);
      expect(ErrorBody.parse(await refused.json())).toEqual(ErrorBody.parse(await wrong.json()));
      expect(refused.headers.get("set-cookie")).toBeNull();

      // Sign-up with the same email succeeds at once, while the old erasure is still pending: a NEW user and tenant.
      const again = await post("/api/auth/sign-up", {
        email: "ada@erase.test",
        password: NEW_PASSWORD,
      });
      expect(again.status).toBe(202);
      expect(SignUpResponse.parse(await again.json())).toEqual({ status: "accepted" });
      const fresh = await idOf("ada@erase.test");
      expect(fresh.id).not.toBe(ada.id);
      expect(fresh.tenant_id).not.toBe(ada.tenant_id);
      // The old row is untouched apart from the placeholder (same password hash, still marked), and the new account logs in.
      const old = (
        await db.owner.query(
          "SELECT password_hash, erasing_at IS NOT NULL AS erasing FROM users WHERE id = $1",
          [ada.id],
        )
      ).rows[0];
      expect(old).toEqual({ password_hash: oldHash, erasing: true });
      expect(
        (await post("/api/auth/login", { email: "ada@erase.test", password: NEW_PASSWORD })).status,
      ).toBe(200);
      expect(
        (await post("/api/auth/login", { email: "ada@erase.test", password: PASSWORD })).status,
      ).toBe(401); // the old password is dead

      expect(
        (await post("/api/auth/login", { email: "bob@erase.test", password: PASSWORD })).status,
      ).toBe(200);
    });

    it("erasing_at alone still refuses login (the second safeguard), whatever the email on the row", async () => {
      await listen();
      await signUp("cy@erase.test");
      expect(
        (await post("/api/auth/login", { email: "cy@erase.test", password: PASSWORD })).status,
      ).toBe(200);
      await db.owner.query("UPDATE users SET erasing_at = now() WHERE email = 'cy@erase.test'"); // marked, email NOT scrubbed
      const refused = await post("/api/auth/login", { email: "cy@erase.test", password: PASSWORD });
      expect(refused.status).toBe(401);
      expect(refused.headers.get("set-cookie")).toBeNull();
    });
  },
);
