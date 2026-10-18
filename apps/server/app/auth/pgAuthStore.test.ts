import { randomUUID } from "node:crypto";
import {
  AuthService,
  type Identity,
  PasswordAuthenticator,
  SESSION_COOKIE,
  hashToken,
  newSessionToken,
  readSessionCookie,
} from "@docmind/auth";
import { runAuthenticatorConformance } from "@docmind/auth/testing";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, setAppRolePassword } from "../db/migrate";
import { APP_PASSWORD, PG_URL, type TestDb, createTestDb } from "../db/testSupport";
import { PgAuthStore } from "./pgAuthStore";

describe.skipIf(!PG_URL)("PgAuthStore (needs DOCMIND_TEST_PG_URL)", () => {
  let db: TestDb;
  let pool: Pool;
  let store: PgAuthStore;

  beforeAll(async () => {
    db = await createTestDb();
    await migrate(db.owner);
    await setAppRolePassword(db.owner, APP_PASSWORD);
    pool = new Pool({ connectionString: db.appUrl });
    store = new PgAuthStore(pool);
  });

  afterAll(async () => {
    await pool?.end();
    await db?.drop();
  });

  // The conformance suite names its callers; each needs an account (once) so the session's keys hold.
  const withAccount = new Set<string>();
  runAuthenticatorConformance(() => {
    const owners = new Map<string, Identity>();
    const cookieFor = (token: string) => ({ cookie: `${SESSION_COOKIE}=${token}` });
    return {
      authenticator: new PasswordAuthenticator(store),
      async issue(identity) {
        if (!withAccount.has(identity.userId)) {
          withAccount.add(identity.userId);
          const email = `${identity.userId}@x.test`;
          await store.createAccount({ ...identity, email, passwordHash: "x" });
        }
        const { token, tokenHash } = newSessionToken();
        owners.set(token, identity);
        await store.createSession({
          ...identity,
          tokenHash,
          expiresAt: new Date(Date.now() + 60_000),
        });
        return cookieFor(token);
      },
      async revoke(headers) {
        const token = readSessionCookie(headers) ?? "";
        const owner = owners.get(token);
        if (owner) await store.deleteSession(owner, hashToken(token));
      },
      forged: () => cookieFor("A".repeat(43)),
    };
  }, "PasswordAuthenticator on PgAuthStore");

  const PASSWORD = "correct horse battery";
  const signedUp = async () => {
    const service = new AuthService(store);
    const email = `${randomUUID()}@example.com`;
    expect(await service.signUp(email, PASSWORD)).toBe(true);
    const started = await service.logIn(email, PASSWORD);
    if (!started) throw new Error("setup failed");
    return { service, email, started };
  };

  it("runs sign-up, login and logout end to end", async () => {
    const { service, email, started } = await signedUp();
    expect(await service.signUp(email, PASSWORD)).toBe(false);
    expect(await store.findEmail(started.identity)).toBe(email);
    const again = await service.logIn(email, PASSWORD);
    expect(again?.identity).toEqual(started.identity);
    await service.logOut(started.identity, started.token);
    const auth = new PasswordAuthenticator(store);
    const cookie = (t: string) => ({ cookie: `${SESSION_COOKIE}=${t}` });
    expect(await auth.authenticate({ headers: cookie(started.token) })).toBeNull();
    expect(await auth.authenticate({ headers: cookie(again?.token ?? "") })).toEqual(
      again?.identity,
    );
  });

  it("cannot end another tenant's session", async () => {
    const { service, started: a } = await signedUp();
    const { started: b } = await signedUp();
    await service.logOut(b.identity, a.token);
    const auth = new PasswordAuthenticator(store);
    const headers = { cookie: `${SESSION_COOKIE}=${a.token}` };
    expect(await auth.authenticate({ headers })).toEqual(a.identity);
  });

  it("purges expired sessions and only those", async () => {
    const { started: user } = await signedUp();
    await db.owner.query(
      "INSERT INTO auth_sessions VALUES ('stale', $1, $2, now() - interval '1 minute')",
      [user.identity.tenantId, user.identity.userId],
    );
    expect(await store.purgeExpiredSessions()).toBe(1);
    expect(await store.findSession(hashToken(user.token))).toEqual(user.identity);
  });
});
