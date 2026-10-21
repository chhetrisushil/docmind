import { existsSync } from "node:fs";
import { join } from "node:path";
import { DeleteAccountResponse } from "@docmind/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PG_URL } from "../db/testSupport";
import { type IngestStack, startIngestStack } from "../documents/ingestStack";
import {
  SECRETS,
  addUserToTenant,
  assertErased,
  captureConsole,
  emailHash,
  eraseMe,
  loginAs,
  namingColumns,
  needlesOf,
  receiptState,
  seedUser,
  throttleKeys,
  waitErased,
} from "./e2eSupport";

const WAIT = 180_000;

describe.skipIf(!PG_URL)(
  "M5 acceptance: DELETE /api/me leaves nothing readable (needs DOCMIND_TEST_PG_URL)",
  () => {
    let st: IngestStack;
    beforeAll(async () => {
      st = await startIngestStack({ chat: true });
    });
    afterAll(async () => {
      await st?.close();
    });

    it(
      "erases an account in a shared tenant: every row, blob, timer and key of the user is gone or unreadable, the colleague's data is not, and nothing sensitive is logged",
      async () => {
        const logs = captureConsole();
        try {
          const ada = await st.signUpAndLogIn("ada@example.com");
          const cam = await addUserToTenant(st, ada.tenantId, "cam@example.com");
          const adaData = await seedUser(st, ada, "ada@example.com");
          const camData = await seedUser(st, cam, "cam@example.com");

          // The scan bites: before the erasure it finds the user in the tables we know hold them.
          const before = await namingColumns(st.db.owner, needlesOf(adaData));
          expect(before).toEqual(
            expect.arrayContaining([
              "public.users.id",
              "public.users.email",
              "public.documents.owner_id",
              "public.documents.id",
              "public.chat_sessions.user_id",
              "public.chat_sessions.id",
            ]),
          );
          expect(before.length).toBeGreaterThan(8);
          expect(adaData.executions.length).toBeGreaterThanOrEqual(3); // conversation, ingest, title
          expect(await st.keys.get(adaData.userId)).not.toBeNull();

          // A wrong password erases nothing and keeps the session.
          const refused = await eraseMe(st, ada.cookie, "not the password");
          expect(refused.status).toBe(401);
          expect((await st.chatReq(ada.cookie, "GET", "/api/me")).status).toBe(200);
          expect(
            (await st.db.owner.query("SELECT count(*)::int AS n FROM erasure_requests")).rows[0].n,
          ).toBe(0);
          // The route keeps counters keyed by a hash of the email (the sign-up and the failed password above).
          const counters = () =>
            st.db.owner
              .query("SELECT count(*)::int AS n FROM auth_throttle WHERE key = ANY($1::text[])", [
                throttleKeys(adaData.email),
              ])
              .then((r) => r.rows[0].n as number);
          expect(await counters()).toBe(2);

          // The right one: 202 with a receipt, the cookie is cleared, the old cookie is already dead.
          const res = await eraseMe(st, ada.cookie);
          expect(res.status).toBe(202);
          const { erasure, receipt } = DeleteAccountResponse.parse(await res.json());
          expect(erasure).toBe("accepted");
          expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
          expect((await st.chatReq(ada.cookie, "GET", "/api/me")).status).toBe(401);

          // What the request transaction alone did, whatever the eraser has done by now: the old email, and the hash
          // of it that keys the throttle counters, are in no table (users.email holds `erased:<id>`, or the row is
          // already gone), the route cleared the counters, and the receipt answers.
          expect(
            await namingColumns(st.db.owner, [adaData.email, emailHash(adaData.email)]),
          ).toEqual([]);
          expect(await counters()).toBe(0);
          expect(await loginAs(st, "ada@example.com").catch((e: Error) => e.message)).toBe(
            "login failed 401",
          );
          expect(["pending", "done"]).toContain((await receiptState(st, receipt)).state);
          // A stranger's receipt and a malformed one are the same 404.
          expect(
            (await receiptState(st, DeleteAccountResponse.shape.receipt.parse("A".repeat(43))))
              .status,
          ).toBe(404);
          expect((await receiptState(st, "not-a-receipt")).status).toBe(404);

          await waitErased(st, adaData.userId);
          expect(await receiptState(st, receipt)).toEqual({ status: 200, state: "done" });
          await assertErased(st, adaData, { tenantGone: false });

          // The colleague, in the same tenant, is untouched, and the scan finds them (it is not blind).
          const camRows = await namingColumns(st.db.owner, needlesOf(camData));
          expect(camRows).toEqual(
            expect.arrayContaining([
              "public.users.id",
              "public.documents.owner_id",
              "public.chat_sessions.user_id",
            ]),
          );
          expect(await st.keys.get(camData.userId)).not.toBeNull();
          expect(existsSync(join(st.root, camData.tenantId, camData.userId))).toBe(true);

          // Nothing the eraser (or anything else) printed carries a UUID, the user's email or text.
          logs.assertClean([adaData.email, receipt, ...adaData.sentinels, ...SECRETS]);
        } finally {
          logs.restore();
        }
      },
      WAIT,
    );

    it(
      "erases a user who is alone in their tenant: the personal tenant goes too",
      async () => {
        const logs = captureConsole();
        try {
          const dan = await st.signUpAndLogIn("dan@example.com");
          const danData = await seedUser(st, dan, "dan@example.com");
          const res = await eraseMe(st, dan.cookie);
          expect(res.status).toBe(202);
          const { receipt } = DeleteAccountResponse.parse(await res.json());
          await waitErased(st, danData.userId);
          expect(await receiptState(st, receipt)).toEqual({ status: 200, state: "done" });
          await assertErased(st, danData, { tenantGone: true });
          logs.assertClean([danData.email, receipt, ...danData.sentinels, ...SECRETS]);
        } finally {
          logs.restore();
        }
      },
      WAIT,
    );
  },
);
