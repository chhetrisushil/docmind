import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { T1, T2, U1, U1B, U2, seedUsers } from "../documents/testHarness";
import { ERASURE_STEPS } from "../erasure/types";
import { migrate, setAppRolePassword } from "./migrate";
import { withTenant } from "./tenant";
import { APP_PASSWORD, PG_URL, type TestDb, createTestDb } from "./testSupport";

const FUNCTIONS = [
  "docmind_delete_empty_tenant",
  "docmind_erasure_mark",
  "docmind_erasure_pending",
  "docmind_erasure_status",
];

describe.skipIf(!PG_URL)(
  "erasure_requests and its functions (0024) (needs DOCMIND_TEST_PG_URL)",
  () => {
    let db: TestDb;
    let owner: Pool;
    let app: Pool;

    beforeAll(async () => {
      db = await createTestDb();
      owner = db.owner;
      await migrate(owner);
      await setAppRolePassword(owner, APP_PASSWORD);
      await seedUsers(owner);
      app = new Pool({ connectionString: db.appUrl });
    });
    afterAll(async () => {
      await app?.end();
      await db?.drop();
    });

    // The receipt hash each request was made with, by user (the server derives it from a random token).
    const receipts = new Map<string, Buffer>();
    const newHash = () =>
      createHash("sha256").update(randomBytes(32).toString("base64url")).digest();
    const request = (tenant: string, user: string) => {
      const hash = newHash();
      receipts.set(user, hash);
      return withTenant(app, tenant, (tx) =>
        tx.query(
          "INSERT INTO erasure_requests (user_id, tenant_id, receipt_hash) VALUES ($1, $2, $3)",
          [user, tenant, hash],
        ),
      );
    };
    const stateOf = async (user: string) =>
      (
        await owner.query(
          "SELECT state, steps, attempts, completed_at FROM erasure_requests WHERE user_id = $1",
          [user],
        )
      ).rows[0];

    it("adds users.erasing_at, null for everyone", async () => {
      const { rows } = await owner.query("SELECT erasing_at FROM users");
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.erasing_at === null)).toBe(true);
    });

    describe("the table", () => {
      it("lets a session insert its own tenant's user as pending, with no steps, and nothing else", async () => {
        await request(T1, U1);
        expect(await stateOf(U1)).toMatchObject({
          state: "pending",
          steps: [],
          attempts: 0,
          completed_at: null,
        });
      });

      it("refuses a request for another tenant, for a user who is not in the tenant, and for a pre-filled one", async () => {
        await expect(request(T1, U2)).rejects.toThrow(/row-level security/); // bob belongs to tenant 2
        await expect(request(T1, randomUUID())).rejects.toThrow(/row-level security/);
        const forged = (cols: string, vals: unknown[]) =>
          withTenant(app, T1, (tx) =>
            tx.query(
              `INSERT INTO erasure_requests (user_id, tenant_id, receipt_hash, ${cols}) VALUES ($1, $2, $3, ${vals.map((_, i) => `$${i + 4}`).join(", ")})`,
              [U1B, T1, newHash(), ...vals],
            ),
          );
        await expect(forged("state, completed_at", ["done", new Date()])).rejects.toThrow(
          /row-level security/,
        );
        await expect(forged("steps", [["stop"]])).rejects.toThrow(/row-level security/);
      });

      it("a second insert for the same user is a no-op", async () => {
        await withTenant(app, T1, (tx) =>
          tx.query(
            "INSERT INTO erasure_requests (user_id, tenant_id, receipt_hash) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
            [U1, T1, newHash()],
          ),
        );
        expect(
          (await owner.query("SELECT 1 FROM erasure_requests WHERE user_id = $1", [U1])).rowCount,
        ).toBe(1);
        const stored = (
          await owner.query("SELECT receipt_hash FROM erasure_requests WHERE user_id = $1", [U1])
        ).rows[0].receipt_hash;
        expect(stored).toEqual(receipts.get(U1)); // the first receipt stays the only one
      });

      it("keeps one request per receipt hash, and only a 32-byte hash", async () => {
        await expect(
          owner.query(
            "INSERT INTO erasure_requests (user_id, tenant_id, receipt_hash) VALUES ($1, $2, $3)",
            [randomUUID(), T1, receipts.get(U1)],
          ),
        ).rejects.toThrow(/erasure_requests_receipt_hash_key/);
        await expect(
          owner.query(
            "INSERT INTO erasure_requests (user_id, tenant_id, receipt_hash) VALUES ($1, $2, $3)",
            [randomUUID(), T1, randomBytes(8)],
          ),
        ).rejects.toThrow(/erasure_requests_receipt_hash_len/);
        await expect(
          owner.query("INSERT INTO erasure_requests (user_id, tenant_id) VALUES ($1, $2)", [
            randomUUID(),
            T1,
          ]),
        ).rejects.toThrow(/null value in column "receipt_hash"/);
      });

      it("the app role cannot read, change or delete a request except through the functions", async () => {
        for (const sql of [
          "SELECT * FROM erasure_requests",
          "UPDATE erasure_requests SET state = 'done'",
          "DELETE FROM erasure_requests",
        ])
          await expect(withTenant(app, T1, (tx) => tx.query(sql))).rejects.toThrow(
            /permission denied/,
          );
      });

      it("refuses an unknown step in steps, and a done request without a completion time", async () => {
        await expect(
          owner.query("UPDATE erasure_requests SET steps = ARRAY['teleport'] WHERE user_id = $1", [
            U1,
          ]),
        ).rejects.toThrow(/erasure_requests_steps_check/);
        await expect(
          owner.query("UPDATE erasure_requests SET state = 'done' WHERE user_id = $1", [U1]),
        ).rejects.toThrow(/erasure_requests_done_pair/);
      });
    });

    describe("docmind_erasure_pending / docmind_erasure_mark", () => {
      it("lists the pending requests across tenants: ids, steps and a counter", async () => {
        await request(T2, U2);
        const { rows } = await app.query("SELECT * FROM docmind_erasure_pending()"); // the default state is 'pending'
        expect(rows.map((r) => r.user_id).sort()).toEqual([U1, U2].sort());
        expect(rows.find((r) => r.user_id === U2)).toEqual({
          user_id: U2,
          tenant_id: T2,
          state: "pending",
          steps: [],
          attempts: 0,
        });
      });

      it("records a step once, in the order marked, and counts a retry without recording a step", async () => {
        const mark = async (step: string, done = false) =>
          (await app.query("SELECT docmind_erasure_mark($1, $2, $3) AS found", [U1, step, done]))
            .rows[0].found;
        expect(await mark("stop")).toBe(true);
        expect(await mark("shred")).toBe(true);
        expect(await mark("stop")).toBe(true); // again: no duplicate
        expect(await mark("retry")).toBe(true);
        expect(await stateOf(U1)).toMatchObject({
          steps: ["stop", "shred"],
          attempts: 1,
          state: "pending",
        });
      });

      it("done flips the state once and stamps a completion time that a repeat keeps", async () => {
        for (const step of ["readModels", "rows", "blobs", "key"])
          await app.query("SELECT docmind_erasure_mark($1, $2, false)", [U1, step]);
        await app.query("SELECT docmind_erasure_mark($1, 'done', true)", [U1]);
        const first = (await stateOf(U1)).completed_at;
        expect(first).not.toBeNull();
        await app.query("SELECT docmind_erasure_mark($1, 'done', true)", [U1]);
        expect(await stateOf(U1)).toMatchObject({ state: "done", completed_at: first });
        const { rows } = await app.query("SELECT user_id FROM docmind_erasure_pending()");
        expect(rows.map((r) => r.user_id)).toEqual([U2]); // a done request is no longer listed as pending
        const done = await app.query("SELECT user_id, state FROM docmind_erasure_pending('done')");
        expect(done.rows).toEqual([{ user_id: U1, state: "done" }]); // ... and is listed when asked for 'done'
      });

      it("refuses an out-of-order step, a done without its steps and a disagreeing done flag, and changes nothing", async () => {
        const mark = (step: string, done: boolean) =>
          app.query("SELECT docmind_erasure_mark($1, $2, $3)", [U2, step, done]);
        await expect(mark("shred", false)).rejects.toMatchObject({ code: "22023" }); // stop comes first
        await expect(mark("done", true)).rejects.toMatchObject({ code: "22023" }); // done without any step
        await expect(mark("stop", true)).rejects.toMatchObject({ code: "22023" }); // done flag on an ordinary step
        await expect(mark("done", false)).rejects.toMatchObject({ code: "22023" }); // done step without the flag
        expect(await stateOf(U2)).toMatchObject({
          state: "pending",
          steps: [],
          completed_at: null,
        });
      });

      it("a mark after done is a no-op that answers true, and a retry no longer counts", async () => {
        const before = await owner.query("SELECT * FROM erasure_requests WHERE user_id = $1", [U1]);
        for (const step of ["stop", "done", "key"])
          expect(
            (
              await app.query("SELECT docmind_erasure_mark($1, $2, $3) AS f", [
                U1,
                step,
                step === "done",
              ])
            ).rows[0].f,
          ).toBe(true);
        expect(
          (await app.query("SELECT docmind_erasure_mark($1, 'retry', false) AS f", [U1])).rows[0].f,
        ).toBe(false);
        expect(
          (await owner.query("SELECT * FROM erasure_requests WHERE user_id = $1", [U1])).rows,
        ).toEqual(before.rows);
        expect((await stateOf(U1)).steps).toEqual([...ERASURE_STEPS]);
      });

      it("the step list inside the function is ERASURE_STEPS: every step in order succeeds, an unlisted one fails", async () => {
        const ghost = randomUUID(); // no foreign keys: a request needs no user row
        await owner.query(
          "INSERT INTO erasure_requests (user_id, tenant_id, receipt_hash) VALUES ($1, $2, $3)",
          [ghost, T1, newHash()],
        );
        for (const step of ERASURE_STEPS)
          expect(
            (
              await app.query("SELECT docmind_erasure_mark($1, $2, $3) AS f", [
                ghost,
                step,
                step === "done",
              ])
            ).rows[0].f,
          ).toBe(true);
        expect((await stateOf(ghost)).steps).toEqual([...ERASURE_STEPS]);
        await expect(
          app.query("SELECT docmind_erasure_mark($1, 'teleport', false)", [ghost]),
        ).rejects.toMatchObject({
          code: "22023",
        });
        await owner.query("DELETE FROM erasure_requests WHERE user_id = $1", [ghost]);
      });

      it("validates the state: only pending or done, and NULL answers no rows (STRICT)", async () => {
        await expect(
          app.query("SELECT * FROM docmind_erasure_pending('teleport')"),
        ).rejects.toMatchObject({ code: "22023" });
        expect((await app.query("SELECT * FROM docmind_erasure_pending(NULL)")).rowCount).toBe(0);
      });

      it("pages by user id: strictly after the cursor, ascending, at most the limit, nothing skipped or repeated", async () => {
        const users: string[] = [];
        for (let n = 0; n < 6; n++) {
          const id = randomUUID();
          await owner.query(
            "INSERT INTO users (id, tenant_id, email, password_hash) VALUES ($1, $2, $3, 'x')",
            [id, T1, `keyset-${n}@example.com`],
          );
          await request(T1, id);
          users.push(id);
        }
        const NIL = "00000000-0000-0000-0000-000000000000";
        const page = async (after: string, limit: number) =>
          (
            await app.query("SELECT user_id FROM docmind_erasure_pending('pending', $1, $2)", [
              after,
              limit,
            ])
          ).rows.map((r) => r.user_id as string);
        const all = (await page(NIL, 1000)).filter((id) => users.includes(id));
        expect(all).toEqual([...users].sort());
        const seen: string[] = [];
        let after = NIL;
        for (;;) {
          const rows = await page(after, 4);
          if (rows.length === 0) break;
          expect(rows.length).toBeLessThanOrEqual(4);
          seen.push(...rows);
          after = rows[rows.length - 1] as string;
        }
        expect(seen.filter((id) => users.includes(id))).toEqual([...users].sort());
        expect(new Set(seen).size).toBe(seen.length); // no repeats
        expect(await page(seen[seen.length - 1] as string, 4)).toEqual([]);
        // Later tests in this file count the pending requests: leave none of these behind.
        await owner.query("DELETE FROM erasure_requests WHERE user_id = ANY($1::uuid[])", [users]);
        await owner.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [users]);
      });

      it("rejects a limit outside 1 to 1000 and an unknown state, and answers nothing for NULL", async () => {
        await expect(
          app.query(
            "SELECT * FROM docmind_erasure_pending('pending', '00000000-0000-0000-0000-000000000000', 0)",
          ),
        ).rejects.toMatchObject({ code: "22023" });
        await expect(
          app.query(
            "SELECT * FROM docmind_erasure_pending('pending', '00000000-0000-0000-0000-000000000000', 1001)",
          ),
        ).rejects.toMatchObject({ code: "22023" });
        await expect(app.query("SELECT * FROM docmind_erasure_pending('teleport')")).rejects.toMatchObject({
          code: "22023",
        });
        expect(
          (await app.query("SELECT * FROM docmind_erasure_pending('pending', NULL, 10)")).rowCount,
        ).toBe(0);
      });

      it("answers false for a request that does not exist, rejects an unknown step, and is STRICT", async () => {
        expect(
          (await app.query("SELECT docmind_erasure_mark($1, 'stop', false) AS f", [randomUUID()]))
            .rows[0].f,
        ).toBe(false);
        await expect(
          app.query("SELECT docmind_erasure_mark($1, 'teleport', false)", [U2]),
        ).rejects.toMatchObject({ code: "22023" });
        expect(
          (await app.query("SELECT docmind_erasure_mark(NULL, 'stop', false) AS f")).rows[0].f,
        ).toBeNull();
      });
    });

    describe("docmind_erasure_status", () => {
      const status = async (hash: Buffer | null) =>
        (await app.query("SELECT public.docmind_erasure_status($1) AS s", [hash])).rows[0].s;

      it("answers the state of the request a receipt hash belongs to, across tenants, and NULL for any other hash", async () => {
        expect(await status(receipts.get(U2) as Buffer)).toBe("pending"); // bob, tenant 2: the caller needs no tenant context
        expect(await status(receipts.get(U1) as Buffer)).toBe("done"); // finished above
        expect(await status(newHash())).toBeNull();
        expect(await status(Buffer.alloc(0))).toBeNull();
      });

      it("is STRICT: a NULL hash answers NULL, and it takes a hash and returns a state, nothing else", async () => {
        expect(await status(null)).toBeNull();
        const { rows } = await owner.query(
          "SELECT pg_get_function_arguments(oid) AS args, pg_get_function_result(oid) AS result FROM pg_proc WHERE proname = 'docmind_erasure_status'",
        );
        expect(rows).toEqual([{ args: "p_receipt_hash bytea", result: "text" }]);
      });
    });

    describe("docmind_delete_empty_tenant", () => {
      it("keeps a tenant that still has a user, deletes one that has none, and ignores NULL and unknown ids", async () => {
        const del = async (t: string | null) =>
          (await app.query("SELECT docmind_delete_empty_tenant($1) AS gone", [t])).rows[0].gone;
        // Its own tenant and user, so the seeded ones stay for the tests below.
        const [tenant, user] = [randomUUID(), randomUUID()];
        await owner.query("SELECT auth_sign_up($1, $2, $3, 'hash')", [
          tenant,
          user,
          `${user}@example.com`,
        ]);
        expect(await del(tenant)).toBe(false);
        expect((await owner.query("SELECT 1 FROM tenants WHERE id = $1", [tenant])).rowCount).toBe(
          1,
        );
        await owner.query("DELETE FROM users WHERE tenant_id = $1", [tenant]);
        expect(await del(tenant)).toBe(true);
        expect((await owner.query("SELECT 1 FROM tenants WHERE id = $1", [tenant])).rowCount).toBe(
          0,
        );
        expect(await del(tenant)).toBe(false); // again: gone already
        expect(await del(null)).toBeNull();
        expect(await del(randomUUID())).toBe(false);
        expect((await owner.query("SELECT 1 FROM tenants WHERE id = $1", [T2])).rowCount).toBe(1); // seeded tenants untouched
      });
    });

    describe("a user who is being erased cannot log in or authenticate", () => {
      it("auth_find_login and auth_find_session stop answering once erasing_at is set, by the user's own transaction", async () => {
        await withTenant(app, T1, (tx) =>
          tx.query(
            "INSERT INTO auth_sessions (token_hash, tenant_id, user_id, expires_at) VALUES ('live', $1, $2, now() + interval '1 day')",
            [T1, U1B],
          ),
        );
        expect(
          (await app.query("SELECT * FROM auth_find_login('alice2@example.com')")).rowCount,
        ).toBe(1);
        expect((await app.query("SELECT * FROM auth_find_session('live')")).rowCount).toBe(1);
        await withTenant(app, T1, (tx) =>
          tx.query("UPDATE users SET erasing_at = now() WHERE id = $1", [U1B]),
        );
        expect(
          (await app.query("SELECT * FROM auth_find_login('alice2@example.com')")).rowCount,
        ).toBe(0);
        expect((await app.query("SELECT * FROM auth_find_session('live')")).rowCount).toBe(0);
        expect(
          (await app.query("SELECT * FROM auth_find_login('alice@example.com')")).rowCount,
        ).toBe(1); // another user is unaffected
      });
    });

    it("an erasing user stays erasing: erasing_at cannot be cleared or changed, and the email can only be the scrubbed one", async () => {
      const upd = (sql: string) => withTenant(app, T1, (tx) => tx.query(sql, [U1B]));
      await expect(upd("UPDATE users SET erasing_at = NULL WHERE id = $1")).rejects.toMatchObject({
        code: "23514",
      });
      await expect(
        upd("UPDATE users SET erasing_at = now() + interval '1 day' WHERE id = $1"),
      ).rejects.toMatchObject({
        code: "23514",
      });
      await expect(
        upd("UPDATE users SET email = 'back@example.com' WHERE id = $1"),
      ).rejects.toMatchObject({ code: "23514" });
      await upd("UPDATE users SET email = 'erased:' || id::text WHERE id = $1"); // the scrub is allowed
      expect(
        (await owner.query("SELECT erasing_at FROM users WHERE id = $1", [U1B])).rows[0].erasing_at,
      ).not.toBeNull();
    });

    it("the app role can rewrite users.email inside its own tenant transaction, and only there (the request-time scrub needs no function)", async () => {
      const scrub = (tenant: string, user: string) =>
        withTenant(app, tenant, (tx) =>
          tx.query("UPDATE users SET email = 'erased:' || id::text WHERE id = $1", [user]),
        ) as Promise<{ rowCount: number }>;
      expect((await scrub(T1, U2)).rowCount).toBe(0); // bob belongs to tenant 2: RLS hides the row
      expect(
        (await owner.query("SELECT email FROM users WHERE id = $1", [U2])).rows[0].email,
      ).not.toMatch(/^erased:/);
      expect((await scrub(T1, U1B)).rowCount).toBe(1);
      expect(
        (await owner.query("SELECT email FROM users WHERE id = $1", [U1B])).rows[0].email,
      ).toBe(`erased:${U1B}`);
      expect(
        (await owner.query("SELECT 1 FROM users WHERE email = 'alice2@example.com'")).rowCount,
      ).toBe(0); // the old address is free
    });

    it("the four definer functions pin search_path, are definers, are strict, and are executable by the app role alone", async () => {
      const { rows } = await owner.query(
        `SELECT p.proname, p.prosecdef, p.proisstrict, p.proconfig,
              pg_get_userbyid(p.proowner) AS owner,
              (SELECT array_agg(g ORDER BY g) FROM (
                 SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END || ':' || a.privilege_type AS g
                   FROM aclexplode(p.proacl) a) x) AS acl
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = ANY ($1) ORDER BY p.proname`,
        [FUNCTIONS],
      );
      expect(rows.map((r) => r.proname)).toEqual(FUNCTIONS);
      for (const r of rows) {
        expect(r.prosecdef).toBe(true);
        expect(r.proconfig).toEqual(["search_path=pg_catalog, pg_temp"]);
        expect(r.acl).toEqual([`${r.owner}:EXECUTE`, "docmind_app:EXECUTE"].sort());
      }
      expect(rows.filter((r) => r.proisstrict).map((r) => r.proname)).toEqual(FUNCTIONS); // each takes arguments, so each is STRICT
    });
  },
);
