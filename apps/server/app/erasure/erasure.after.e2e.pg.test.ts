import { rmSync } from "node:fs";
import {
  ChatSessionDto,
  DeleteAccountResponse,
  ListChatsResponse,
  ListDocumentsResponse,
  ListMessagesResponse,
} from "@docmind/contracts";
import { afterAll, describe, expect, it } from "vitest";
import { collectUntil, isReply, scriptChat } from "../chats/e2eSupport";
import { PG_URL } from "../db/testSupport";
import { type IngestStack, startIngestStack } from "../documents/ingestStack";
import {
  SECRETS,
  type Seeded,
  addUserToTenant,
  assertErased,
  captureConsole,
  emailHash,
  eraseMe,
  loginAs,
  namingColumns,
  receiptState,
  seedUser,
  throttleKeys,
  waitErased,
} from "./e2eSupport";

const WAIT = 300_000;

describe.skipIf(!PG_URL)("M5 acceptance: after the erasure (needs DOCMIND_TEST_PG_URL)", () => {
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

  /** What a signed-in user sees: documents, chats, the messages of their chat, and the reasoning of its reply. */
  async function observe(st: IngestStack, who: Seeded) {
    const docs = ListDocumentsResponse.parse(
      await (await st.chatReq(who.cookie, "GET", "/api/documents")).json(),
    );
    const chats = ListChatsResponse.parse(
      await (await st.chatReq(who.cookie, "GET", "/api/chats")).json(),
    );
    const history = ListMessagesResponse.parse(
      await (await st.chatReq(who.cookie, "GET", `/api/chats/${who.chatId}/messages`)).json(),
    );
    const reply = history.items.find((m) => m.role === "assistant");
    const reasoning = await (
      await st.chatReq(
        who.cookie,
        "GET",
        `/api/chats/${who.chatId}/reasoning?cursor=${reply?.cursor}`,
      )
    ).json();
    return {
      documents: docs.items.map((d) => [d.id, d.status]),
      chats: chats.items.map((c) => [c.id, c.title, c.messageCount]),
      history: history.items,
      reasoning,
    };
  }
  /** The erased user's footprint in the log and the audit row: a re-run must not change it. */
  async function footprint(st: IngestStack, who: Seeded) {
    const ids = ((await st.durable.raw.eventStore.listExecutions?.()) ?? []).filter((id) =>
      id.includes(who.userId),
    );
    const counts = await Promise.all(
      ids.map(async (id) => (await st.durable.raw.eventStore.read(id)).length),
    );
    const audit = await st.db.owner.query(
      "SELECT state, steps, updated_at, completed_at FROM erasure_requests WHERE user_id = $1",
      [who.userId],
    );
    return { ids: ids.sort(), counts, audit: audit.rows };
  }

  it(
    "the neighbour keeps working, the old credentials are dead, a re-run changes nothing, sign-up starts fresh, and the server restarts twice (once with a forced read-model rebuild)",
    async () => {
      const logs = captureConsole();
      try {
        const first = track(await startIngestStack({ chat: true }));
        const claude = first.claude;
        if (!claude) throw new Error("no fake Claude");
        const adaLogin = await first.signUpAndLogIn("ada@example.com");
        const camLogin = await addUserToTenant(first, adaLogin.tenantId, "cam@example.com");
        const ada = await seedUser(first, adaLogin, "ada@example.com");
        const cam = await seedUser(first, camLogin, "cam@example.com");
        const camBefore = await observe(first, cam);
        expect(camBefore.documents).toEqual([[cam.documentId, "ready"]]);
        expect(camBefore.chats).toEqual([[cam.chatId, cam.title, 2]]);

        const erased = await eraseMe(first, ada.cookie);
        expect(erased.status).toBe(202);
        const { receipt } = DeleteAccountResponse.parse(await erased.json());
        await waitErased(first, ada.userId);
        expect(await receiptState(first, receipt)).toEqual({ status: 200, state: "done" });
        await assertErased(first, ada, { tenantGone: false });

        // 1. the colleague is untouched, and can keep chatting (the conversation under the same tenant still runs)
        expect(await observe(first, cam)).toEqual(camBefore);
        scriptChat(claude, () => ({
          stream: { steps: [{ text: "Two percent per month." }, { stop: "end_turn" }] },
        }));
        const stream = await first.openChat(cam.cookie, cam.chatId);
        try {
          const sent = await first.chatReq(
            cam.cookie,
            "POST",
            `/api/chats/${cam.chatId}/messages`,
            {
              text: "And what about late payment?",
            },
          );
          expect(sent.status).toBe(202);
          await collectUntil(
            stream,
            (f) => isReply(f) && (f.data as { text: string }).text === "Two percent per month.",
          );
        } finally {
          stream.close();
        }
        const camAfterTurn = await observe(first, cam);
        expect(camAfterTurn.history.map((m) => m.role)).toEqual([
          "user",
          "assistant",
          "user",
          "assistant",
        ]);

        // 2. the old credentials fail, with the answer of a wrong password (no account has that email: it was
        //    replaced at the request); the old cookie is dead
        await expect(loginAs(first, "ada@example.com")).rejects.toThrow("login failed 401");
        expect((await first.chatReq(ada.cookie, "GET", "/api/me")).status).toBe(401);

        // 3. re-running is a no-op: the same footprint, the same audit row, no model call
        const footprintBefore = await footprint(first, ada);
        const modelCalls = claude.requests.length;
        await first.eraser.run(ada.userId);
        await first.eraser.resumeAll();
        await first.eraser.idle();
        expect(await footprint(first, ada)).toEqual(footprintBefore);
        expect(claude.requests.length).toBe(modelCalls);
        await assertErased(first, ada, { tenantGone: false });

        // 4. the same email signs up again (after the erasure; the next test does it before the eraser has run),
        //    as a different, empty account
        const again = await first.signUpAndLogIn("ada@example.com");
        expect(again.userId).not.toBe(ada.userId);
        expect(again.tenantId).not.toBe(ada.tenantId);
        const docs = ListDocumentsResponse.parse(
          await (await first.chatReq(again.cookie, "GET", "/api/documents")).json(),
        );
        const chats = ListChatsResponse.parse(
          await (await first.chatReq(again.cookie, "GET", "/api/chats")).json(),
        );
        expect([docs.items, chats.items]).toEqual([[], []]);
        await assertErased(first, ada, { tenantGone: false, emailReused: true }); // the new account took none of it back
        expect(await receiptState(first, receipt)).toEqual({ status: 200, state: "done" }); // a done receipt keeps answering

        // 5. restart: catch-up over a log that holds a shredded user boots, and nothing changes
        await first.close({ keepDb: true });
        stacks.splice(stacks.indexOf(first), 1);
        const resume = { db: first.db, kek: first.kek, root: first.root };
        const second = track(await startIngestStack({ chat: true, resume }));
        expect(await observe(second, cam)).toEqual(camAfterTurn);
        await assertErased(second, ada, { tenantGone: false, emailReused: true }); // ada's address belongs to the new account now
        expect(await receiptState(second, receipt)).toEqual({ status: 200, state: "done" }); // ... and the receipt survives a restart

        // 6. restart again, after throwing the read models away: every model refolds from the start over the
        //    shredded logs. The restart goes through the real compose boot path (`startIngestStack` composes
        //    `buildServer` and `bootIngest`), so after the models catch up `afterListen` calls `Eraser.resumeAll`,
        //    which re-runs `forgetUser` for every done erasure and re-tombstones whatever the refold re-created for
        //    the erased user. The strict `live` query of `assertErased` therefore stays as it is: no row of the
        //    erased user is live. The test awaits one more `resumeAll` (idempotent) only to make the wait deterministic.
        await second.close({ keepDb: true });
        stacks.splice(stacks.indexOf(second), 1);
        await second.db.owner.query("DELETE FROM read_model_state");
        await second.db.owner.query("DELETE FROM read_model_folds");
        const third = track(await startIngestStack({ chat: true, resume }));
        await third.eraser.resumeAll();
        expect(await observe(third, cam)).toEqual(camAfterTurn);
        await assertErased(third, ada, { tenantGone: false, tombstones: false, emailReused: true });
        // Across both restarts, the parked-free erasure and the sign-up: no UUID, sentinel or email was printed.
        logs.assertClean([ada.email, receipt, ...ada.sentinels, ...cam.sentinels, ...SECRETS]);
      } finally {
        logs.restore();
      }
    },
    WAIT,
  );

  it(
    "a re-sign-up with the same email works the moment the 202 lands, before the eraser has run: the old email is in no table, and the receipt reads pending, then done",
    async () => {
      const logs = captureConsole();
      // The eraser is held at its lock until released: nothing of the erasure runs in between, so what the
      // assertions see is what the request transaction alone did.
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const st = track(
        await startIngestStack({
          chat: true,
          wrapErasure: (deps) => ({
            ...deps,
            lock: async (userId) => {
              await gate;
              return deps.lock(userId);
            },
          }),
        }),
      );
      const login = await st.signUpAndLogIn("gus@example.com");
      const gus = await seedUser(st, login, "gus@example.com");
      let receipt = "";
      let again: Awaited<ReturnType<IngestStack["signUpAndLogIn"]>>;
      try {
        const res = await eraseMe(st, gus.cookie);
        expect(res.status).toBe(202);
        receipt = DeleteAccountResponse.parse(await res.json()).receipt;

        // 1. nothing has been erased yet: the request is pending with no step done, and the receipt says so
        const audit = await st.db.owner.query(
          "SELECT state, steps FROM erasure_requests WHERE user_id = $1",
          [gus.userId],
        );
        expect(audit.rows).toEqual([{ state: "pending", steps: [] }]);
        expect(await receiptState(st, receipt)).toEqual({ status: 200, state: "pending" });
        expect(await st.keys.get(gus.userId)).not.toBeNull(); // the key is alive: the shred has not run

        // 2. and yet the old email is in no table: the row still exists, under the placeholder
        expect(await namingColumns(st.db.owner, [gus.email, emailHash(gus.email)])).toEqual([]);
        expect(
          (
            await st.db.owner.query(
              "SELECT count(*)::int AS n FROM auth_throttle WHERE key = ANY($1::text[])",
              [throttleKeys(gus.email)],
            )
          ).rows[0].n,
        ).toBe(0); // the route cleared the counters keyed by the old email
        expect(
          (await st.db.owner.query("SELECT email FROM users WHERE id = $1", [gus.userId])).rows,
        ).toEqual([{ email: `erased:${gus.userId}` }]);

        // 3. the old credentials are dead
        await expect(loginAs(st, gus.email)).rejects.toThrow("login failed 401");

        // 4. the same email signs up at once, as a new user in a new tenant, who sees nothing of the old one
        again = await st.signUpAndLogIn("gus@example.com");
        expect(again.userId).not.toBe(gus.userId);
        expect(again.tenantId).not.toBe(gus.tenantId);
        const docs = ListDocumentsResponse.parse(
          await (await st.chatReq(again.cookie, "GET", "/api/documents")).json(),
        );
        const chats = ListChatsResponse.parse(
          await (await st.chatReq(again.cookie, "GET", "/api/chats")).json(),
        );
        expect([docs.items, chats.items]).toEqual([[], []]);
        expect(await receiptState(st, receipt)).toEqual({ status: 200, state: "pending" }); // still the old erasure's
      } finally {
        release();
      }
      try {
        // 5. the eraser runs: the receipt reads done, nothing of the old user is left, the new account is untouched
        await waitErased(st, gus.userId);
        expect(await receiptState(st, receipt)).toEqual({ status: 200, state: "done" });
        await assertErased(st, gus, { tenantGone: true, emailReused: true });
        expect((await st.chatReq(again.cookie, "GET", "/api/me")).status).toBe(200);
        expect(
          (await st.db.owner.query("SELECT email FROM users WHERE id = $1", [again.userId])).rows,
        ).toEqual([{ email: "gus@example.com" }]);
        logs.assertClean([gus.email, receipt, ...gus.sentinels, ...SECRETS]);
      } finally {
        logs.restore();
      }
    },
    WAIT,
  );
  it(
    "the user's open document and chat streams end when the account is deleted",
    async () => {
      const logs = captureConsole();
      const st = track(await startIngestStack({ chat: true })); // its SSE heartbeat is pinned at ten minutes
      const login = await st.signUpAndLogIn("ivy@example.com");
      const chat = ChatSessionDto.parse(
        await (await st.chatReq(login.cookie, "POST", "/api/chats", {})).json(),
      );
      const docs = await st.events(login.cookie);
      const chats = await st.openChat(login.cookie, chat.id);
      /** Reads frames (heartbeats included) until the server ends the stream. */
      const ends = async (stream: typeof docs) => {
        const outcome = await Promise.race([
          (async () => {
            for (;;) await stream.next();
          })().catch((err: Error) => (err.message === "stream ended" ? "ended" : "failed")),
          new Promise((resolve) => setTimeout(() => resolve("open"), 5_000)),
        ]);
        return outcome;
      };
      try {
        expect((await eraseMe(st, login.cookie)).status).toBe(202);
        expect(await ends(docs)).toBe("ended");
        expect(await ends(chats)).toBe("ended");
        await waitErased(st, login.userId);
        logs.assertClean(["ivy@example.com", ...SECRETS]);
      } finally {
        docs.close();
        chats.close();
        logs.restore();
      }
    },
    WAIT,
  );
});
