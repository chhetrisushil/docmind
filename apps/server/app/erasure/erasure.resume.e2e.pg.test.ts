import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { afterAll, describe, expect, it, vi } from "vitest";
import { scriptChat } from "../chats/e2eSupport";
import { PG_URL } from "../db/testSupport";
import { type IngestStack, startIngestStack } from "../documents/ingestStack";
import {
  SECRETS,
  assertErased,
  captureConsole,
  eraseMe,
  eventColumnProblems,
  handleOfExecutions,
  intentRows,
  loginAs,
  seedUser,
  waitErased,
} from "./e2eSupport";
import type { ErasureDeps } from "./eraser";

const WAIT = 300_000;

describe.skipIf(!PG_URL)(
  "M5 acceptance: an interrupted or deferred erasure completes (needs DOCMIND_TEST_PG_URL)",
  () => {
    const stacks: IngestStack[] = [];
    const dbs = new Set<IngestStack["db"]>();
    const roots = new Set<string>();
    const track = (s: IngestStack) => {
      stacks.push(s);
      dbs.add(s.db);
      roots.add(s.root);
      return s;
    };
    afterAll(async () => {
      for (const s of stacks.splice(0)) await s.close({ keepDb: true });
      for (const db of dbs) await db.drop();
      for (const root of roots) rmSync(root, { recursive: true, force: true });
    });

    it(
      "a process that dies between the shred and the rows resumes at boot: the half-erased account is dead, then it is gone",
      async () => {
        const logs = captureConsole(); // the failing step logs its class on every retry
        try {
          // Everything up to and including the shred runs; the `rows` step then fails until the process is "killed".
          const wrap = (deps: ErasureDeps): ErasureDeps => ({
            ...deps,
            rows: async () => {
              throw new Error("simulated crash before the rows step");
            },
          });
          const first = track(await startIngestStack({ chat: true, wrapErasure: wrap }));
          const login = await first.signUpAndLogIn("eve@example.com");
          const eve = await seedUser(first, login, "eve@example.com");
          expect((await eraseMe(first, eve.cookie)).status).toBe(202);

          await vi.waitFor(
            async () => {
              const { rows } = await first.db.owner.query(
                "SELECT steps FROM erasure_requests WHERE user_id = $1",
                [eve.userId],
              );
              expect(rows[0]?.steps).toEqual(["stop", "shred", "readModels"]);
            },
            { timeout: 90_000, interval: 100 },
          );
          // The half-erased state: the key is gone, the sealed log refuses, the row is still there and marked.
          expect(await first.keys.wasDestroyed(eve.userId)).toBe(true);
          const row = await first.db.owner.query(
            "SELECT erasing_at IS NOT NULL AS erasing FROM users WHERE id = $1",
            [eve.userId],
          );
          expect(row.rows).toEqual([{ erasing: true }]);
          await expect(loginAs(first, "eve@example.com")).rejects.toThrow("login failed 401"); // erasing: refused
          expect(
            (
              await first.db.owner.query("SELECT state FROM erasure_requests WHERE user_id = $1", [
                eve.userId,
              ])
            ).rows[0].state,
          ).toBe("pending");

          // "Kill" the process: the request is durable, the eraser stops where it is.
          await first.close({ keepDb: true });
          stacks.splice(stacks.indexOf(first), 1);

          // The next boot finds the pending request and finishes it, with no help from any request.
          const second = track(
            await startIngestStack({
              chat: true,
              resume: { db: first.db, kek: first.kek, root: first.root },
            }),
          );
          await waitErased(second, eve.userId);
          await assertErased(second, eve, { tenantGone: true });
          logs.assertClean([eve.email, ...eve.sentinels, ...SECRETS]);
        } finally {
          logs.restore();
        }
      },
      WAIT,
    );

    it(
      "a crash between Loom's key destroy and its tombstones does not stop the next boot, and the erasure then completes",
      async () => {
        const logs = captureConsole();
        try {
          const first = track(await startIngestStack({ chat: true }));
          const login = await first.signUpAndLogIn("gus@example.com");
          const gus = await seedUser(first, login, "gus@example.com");
          // The shred writes its intents and destroys the key, then every tombstone append is refused.
          await first.db.owner.query(`
            CREATE FUNCTION loom.refuse_tombstone() RETURNS trigger LANGUAGE plpgsql AS
              $$ BEGIN RAISE EXCEPTION 'tombstones refused'; END $$;
            CREATE TRIGGER refuse_tombstone BEFORE INSERT ON loom.events
              FOR EACH ROW WHEN (NEW.event_type = 'PAYLOAD_SHREDDED') EXECUTE FUNCTION loom.refuse_tombstone();`);
          // Loom's shred destroys the subject key of every subject that owns an execution: here the user's handle (every run of
          // the document flows is new-format), since the user's UUID subject owns none.
          const handle = (
            await first.db.owner.query("SELECT id_handle FROM users WHERE id = $1", [gus.userId])
          ).rows[0]?.id_handle as string;
          expect(handle).toMatch(/^[a-z2-7]{26}$/);
          expect((await eraseMe(first, gus.cookie)).status).toBe(202);
          await vi.waitFor(
            async () => {
              expect(await first.keys.wasDestroyed(`h_${handle}`)).toBe(true);
            },
            { timeout: 90_000, interval: 100 },
          );
          const steps = await first.db.owner.query(
            "SELECT steps, state FROM erasure_requests WHERE user_id = $1",
            [gus.userId],
          );
          expect(steps.rows[0]).toMatchObject({ state: "pending" });
          expect(steps.rows[0].steps).not.toContain("shred");
          await first.close({ keepDb: true });
          stacks.splice(stacks.indexOf(first), 1);

          // The log now holds ciphertext, no tombstone and a destroyed key. Lift the fault, and make the read
          // models fold the whole log again, as a version bump or a rebuild does.
          await first.db.owner.query(`
            DROP TRIGGER refuse_tombstone ON loom.events; DROP FUNCTION loom.refuse_tombstone();
            DELETE FROM read_model_state; DELETE FROM read_model_folds;`);
          const second = track(
            await startIngestStack({
              chat: true,
              resume: { db: first.db, kek: first.kek, root: first.root },
            }),
          );
          await waitErased(second, gus.userId);
          await assertErased(second, gus, { tenantGone: true });
          logs.assertClean([gus.email, ...gus.sentinels, ...SECRETS]);
        } finally {
          logs.restore();
        }
      },
      WAIT,
    );

    /** Every EXECUTION_DENIED row on any `h_<handle>` stream: a denied cancel would put the actor's UUID there in the clear. */
    const deniedOnHandle = async (st: IngestStack, handle: string) =>
      (
        await st.db.owner.query(
          "SELECT count(*)::int AS n FROM loom.events WHERE execution_id LIKE $1 AND event_type = 'EXECUTION_DENIED'",
          [`h_${handle}%`],
        )
      ).rows[0].n as number;

    /** Starts a held chat turn for a user, then erases them: the shred parks behind the running turn. */
    const parkedErasure = async (email: string, restartWhileParked: boolean) => {
      const outcomes: string[] = [];
      // Make the park deterministic: the first stop signal is swallowed, so the held turn is still running when the
      // eraser first asks Loom to shred (outcome "parked"); the stop it sends after that park is the real one.
      let swallowed = false;
      const wrap = (deps: ErasureDeps): ErasureDeps => ({
        ...deps,
        stopChat: async (identity, chatId) => {
          if (!swallowed) {
            swallowed = true;
            return;
          }
          await deps.stopChat(identity, chatId);
        },
        eraseSubject: async (userId) => {
          // The process dies right after the park: the h_ subject is shredded, the user's data key and the turn are not.
          if (restartWhileParked && outcomes.includes("parked"))
            throw new Error("simulated crash while the shred is parked");
          const r = await deps.eraseSubject(userId);
          outcomes.push(r.outcome);
          return r;
        },
      });
      const st = track(await startIngestStack({ chat: true, wrapErasure: wrap }));
      const claude = st.claude;
      if (!claude) throw new Error("no fake Claude");
      const login = await st.signUpAndLogIn(email);
      const user = await seedUser(st, login, email);
      const handle = handleOfExecutions(user.executions);
      if (handle === undefined) throw new Error("the seeded user has no new-format executions");

      const asked = `sentinel-ask2-${randomBytes(6).toString("hex")}`;
      const answered = `sentinel-answer2-${randomBytes(6).toString("hex")}`;
      // A second question whose answer stops mid-stream and waits: the turn is running when the erasure begins.
      scriptChat(claude, () => ({
        stream: {
          steps: [
            { text: "Due " },
            { hold: true },
            { text: `in 30 days. ${answered}` },
            { stop: "end_turn" },
          ],
        },
      }));
      const sent = await st.chatReq(user.cookie, "POST", `/api/chats/${user.chatId}/messages`, {
        text: `And the interest? ${asked}`,
      });
      expect(sent.status).toBe(202);
      const gate = await claude.streamHold(); // the model call is under way
      let finishing = st;
      try {
        expect((await eraseMe(st, user.cookie)).status).toBe(202);
        if (restartWhileParked) {
          await vi.waitFor(() => expect(outcomes).toContain("parked"), {
            timeout: 90_000,
            interval: 50,
          });
          expect(await st.keys.wasDestroyed(`h_${handle}`)).toBe(true); // the handle is shredded, the user is parked
          gate.release();
          await st.close({ keepDb: true });
          stacks.splice(stacks.indexOf(st), 1);
          finishing = track(
            await startIngestStack({
              chat: true,
              resume: { db: st.db, kek: st.kek, root: st.root },
            }),
          );
        }
        await waitErased(finishing, user.userId);
      } finally {
        gate.release();
      }
      return { st: finishing, user, handle, asked, answered, outcomes };
    };

    it(
      "an erasure that finds a chat turn running stops it, waits for the conversation to park, and completes",
      async () => {
        const logs = captureConsole();
        try {
          const {
            st,
            user: fay,
            handle,
            asked,
            answered,
            outcomes,
          } = await parkedErasure("fay@example.com", false);
          await assertErased(st, fay, { tenantGone: true }, [asked, answered]);
          // F26: the shred parked behind the running turn, so Loom wrote its plaintext intent. It names the user and
          // nothing else, and the scan's allowance for it was exercised.
          const intents = await intentRows(st, fay.userId);
          expect(outcomes).toContain("parked");
          expect(intents.length).toBeGreaterThanOrEqual(1);
          for (const intent of intents) {
            expect(intent.workflowId).toBe("__loom_erasure__");
            expect(intent.executionId).toBe("__loom_erasure__");
            expect(Object.keys(intent.payload as object)).toEqual(["subjectId"]);
            expect(eventColumnProblems(intent)).toEqual([]);
          }
          // The stop repeated after the park cancels only under subjects whose key is alive: Loom never refused a cancel on the
          // shredded h_ stream, so it appended no denial naming the user.
          expect(await deniedOnHandle(st, handle)).toBe(0);
          logs.assertClean([fay.email, asked, answered, ...fay.sentinels, ...SECRETS]);
        } finally {
          logs.restore();
        }
      },
      WAIT,
    );

    it(
      "the same, with the process killed right after the park: the next boot repeats the stop on a cold cache, denies nothing, and completes",
      async () => {
        const logs = captureConsole();
        try {
          const { st, user, handle, asked, answered } = await parkedErasure(
            "hal@example.com",
            true,
          );
          await assertErased(st, user, { tenantGone: true }, [asked, answered]);
          expect(await deniedOnHandle(st, handle)).toBe(0);
          logs.assertClean([user.email, asked, answered, ...user.sentinels, ...SECRETS]);
        } finally {
          logs.restore();
        }
      },
      WAIT,
    );
  },
);
