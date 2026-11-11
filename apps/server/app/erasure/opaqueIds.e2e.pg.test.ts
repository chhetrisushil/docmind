import { rmSync } from "node:fs";
import { ChatSessionDto, ListMessagesResponse } from "@docmind/contracts";
import type { FakeAnthropic } from "@docmind/llm-anthropic/testing";
import { afterAll, describe, expect, it } from "vitest";
import { vi } from "vitest";
import { opaqueBuilders } from "../chats/chatIds";
import { DOC, collectUntil, createLegacyChat, isReply, scriptChat } from "../chats/e2eSupport";
import { PG_URL } from "../db/testSupport";
import { type IngestStack, startIngestStack } from "../documents/ingestStack";
import { PgDocumentResults } from "../flows/ingest-document/pgResults";
import { commitPlan, visualsLineage } from "../flows/visualize-document/lineage";
import { aPlan } from "../flows/visualize-document/testing";
import { subjectOfExecution } from "../subject";
import {
  assertErased,
  deniedOnHandle,
  eraseMe,
  handleOfExecutions,
  rowsLinkingHandleToIds,
  scanTables,
  seedUser,
  waitErased,
} from "./e2eSupport";
import type { ErasureDeps } from "./eraser";

const WAIT = 300_000;
const UUID_ANYWHERE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const CHUNK_ID = /\[\[([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\]\]/;

/** A `visuals` model that finds one figure in whatever document it is shown and plans a KeyFigure for it. */
function stubPaymentVisuals(claude: FakeAnthropic) {
  claude.reply((body) => {
    const system = typeof body.system === "string" ? body.system : JSON.stringify(body.system);
    const text = JSON.stringify(body.messages);
    if (system.includes("You extract facts")) {
      const chunk = CHUNK_ID.exec(text)?.[1];
      if (!chunk) return { text: '{"facts":[]}' };
      return {
        text: JSON.stringify({
          facts: [
            {
              kind: "figure",
              label: "Payment-due-days",
              value: 30,
              unit: "days",
              chunkIds: [chunk],
            },
          ],
        }),
      };
    }
    return {
      text: JSON.stringify({
        summary: "A headline figure",
        nodes: [
          {
            id: "headline",
            type: "KeyFigure",
            label: "Payment-due-days",
            span: 4,
            props: {},
            binding: { capability: "fact-0", arguments: {}, path: "value", priority: "P0" },
          },
        ],
      }),
    };
  });
}
const SUMMARY = {
  tldr: "Quarterly summary",
  keyPoints: ["Revenue grew"],
  entities: [],
  topics: ["finance"],
  suggestedQuestions: [],
};

describe.skipIf(!PG_URL)(
  "erasure through the composed id wiring (needs DOCMIND_TEST_PG_URL)",
  () => {
    let first: IngestStack | undefined;
    let second: IngestStack | undefined;
    afterAll(async () => {
      await second?.close({ keepDb: true });
      await first?.db.drop();
      if (first) rmSync(first.root, { recursive: true, force: true });
    });

    it(
      "erasing a user with a running h_ run cancels it and destroys the handle's key, and the user's own",
      async () => {
        let reached: () => void = () => {};
        const entered = new Promise<void>((r) => {
          reached = r;
        });
        const hanging = {
          complete: (r: { signal?: AbortSignal }) =>
            new Promise<never>((_, reject) => {
              reached();
              r.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
                once: true,
              });
            }),
        } as never;
        // Seeded on a stack with no summary model (the ingest's summary step would otherwise wait on the hanging one), then resumed with it.
        first = await startIngestStack({ chat: true });
        const login = await first.signUpAndLogIn("hana@example.com");
        const user = await seedUser(first, login, "hana@example.com");
        await first.close({ keepDb: true });
        const st = await startIngestStack({
          chat: true,
          suggestLlm: hanging,
          resume: { db: first.db, kek: first.kek, root: first.root },
        });
        second = st;
        const ref = { tenantId: user.tenantId, userId: user.userId, documentId: user.documentId };
        await new PgDocumentResults(st.app, st.fields).putSummary(ref, SUMMARY);

        expect(await st.composed.suggestTags.start(ref)).toEqual({ kind: "started", run: 1 });
        await entered;
        const runId = await st.runIds.suggestTags(ref, ref.documentId, 1);
        expect(runId).toMatch(/^h_[a-z2-7]{25}[aeimquy4]:suggest-tags-/);
        const principal = { tenant: ref.tenantId, actor: ref.userId };
        expect((await st.composed.app.runtime.loadState(runId, { principal }))?.status).toBe(
          "running",
        );
        const handle = runId.slice(0, runId.indexOf(":")); // the Loom subject of every new-format run: h_<H>
        expect(await st.keys.wasDestroyed(handle)).toBe(false);

        // A document visuals line committed through the composed stores (new-format id `visuals-<H>-<D>`).
        const lineage = visualsLineage({
          events: st.durable.storage.eventStore,
          content: st.composed.lineageContent,
          keys: st.keys,
          subjectOf: subjectOfExecution,
        });
        const line = (await st.composed.ids.ensureUser(ref)).documentLineage(ref.documentId);
        expect(line).toMatch(/^visuals-/);
        await commitPlan(lineage, st.composed.ids, ref, await aPlan("revenue", "Revenue"), () =>
          new Date().toISOString(),
        );
        expect((await lineage.resolveLatest(line)).ok).toBe(true);

        // Every execution of the user, both formats, for the scan below (the handle comes from these ids).
        user.executions = ((await st.durable.raw.eventStore.listExecutions?.()) ?? []).filter(
          (id) => id.includes(handle) || id.includes(user.userId),
        );
        expect(user.executions).toContain(runId);

        // The composed erasure deps carry `ids`: with them erasure names the user's h_ run, cancels it and destroys the handle's key.
        expect((await eraseMe(st, user.cookie)).status).toBe(202);
        await waitErased(st, user.userId, 60_000);
        expect(await st.keys.wasDestroyed(handle)).toBe(true);
        expect(await st.keys.wasDestroyed(user.userId)).toBe(true);
        const { rows } = await st.db.owner.query("SELECT 1 FROM users WHERE id = $1", [
          user.userId,
        ]);
        expect(rows).toEqual([]);
        expect(await lineage.resolveLatest(line)).toMatchObject({
          ok: false,
          refusal: { kind: "refused", finding: { code: "line-erased" } },
        });
        expect(st.composed.ids.cached(user.userId)).toBeUndefined(); // the cached id key went with the subject key
        // Nothing is left that names the user or links the handle to a plain id, whether or not the erasure had to park on the live run.
        await assertErased(st, user, { tenantGone: true });
        expect(
          await rowsLinkingHandleToIds(st.db.owner, handle, [user.userId, user.documentId]),
        ).toEqual([]);
      },
      WAIT,
    );
  },
);

describe.skipIf(!PG_URL)("opaque ids phase 1, end to end (needs DOCMIND_TEST_PG_URL)", () => {
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

  /** The `summary` role of the restarted stack: ingest's map and reduce answers, and the suggest-tags answer. */
  const SUGGEST = {
    model: "none",
    complete: async (r: { system?: unknown }) => {
      const system = String(r.system ?? "");
      const content = system.startsWith("You combine")
        ? JSON.stringify({ ...SUMMARY, suggestedTags: ["Finance"] })
        : system.startsWith("You suggest tags")
          ? '{"suggestedTags":["Finance"]}'
          : '{"summary":"part","entities":[]}';
      return { content, stopReason: "end_turn" };
    },
  } as never;

  it(
    "upload, visualize, suggest tags (after a cold restart) and erase: new runs hold no plain uuid, the handle links to none, nothing is left",
    async () => {
      // Seeded on a chat-only stack with a legacy chat (pinned in Task 3): its turn visuals lineage is old-format (O7) and is judged by its own tests.
      const first = track(await startIngestStack({ chat: true }));
      const login = await first.signUpAndLogIn("opaque@example.com");
      // the user's UUID subject must own a running turn: an old chat
      const user = await seedUser(first, login, "opaque@example.com", { chat: "legacy" });
      const ref = { tenantId: user.tenantId, userId: user.userId, documentId: user.documentId };
      const handle = (await first.runIds.ingest(ref, user.documentId, 1))
        .split(":")[0]
        ?.slice(2) as string;
      expect(handle).toMatch(/^[a-z2-7]{25}[aeimquy4]$/);

      // A cold restart before the erasure, with the visuals role on: the h_ runs recover and the status model folds.
      await first.close({ keepDb: true });
      stacks.splice(stacks.indexOf(first), 1);
      const st = track(
        await startIngestStack({
          chat: true,
          visuals: true,
          suggestLlm: SUGGEST,
          resume: { db: first.db, kek: first.kek, root: first.root },
        }),
      );
      stubPaymentVisuals(st.visualsClaude as FakeAnthropic);
      expect(st.composed.ids.cached(user.userId)?.handle).toBe(handle); // warmed at boot, before the status model
      const doc = await st.chatReq(login.cookie, "GET", `/api/documents/${user.documentId}`);
      expect(doc.status).toBe(200);
      expect(((await doc.json()) as { status: string }).status).toBe("ready");

      // Upload and visualize a second document on the restarted stack.
      const events = await st.events(login.cookie);
      const up = await st.upload(login.cookie, "second.txt", Buffer.from(DOC));
      expect(up.status).toBe(201);
      const doc2 = ((await up.json()) as { document: { id: string } }).document.id;
      const seen = await st.until(events, doc2, (s2) => s2 === "ready" || s2 === "failed");
      expect(seen.at(-1)?.status).toBe("ready");
      events.close();
      const ref2 = { ...ref, documentId: doc2 };
      const gen = Number(
        (
          await st.db.owner.query("SELECT ingest_generation AS g FROM documents WHERE id = $1", [
            doc2,
          ])
        ).rows[0].g,
      );
      const visualizeId = await st.runIds.visualize(ref2, doc2, gen);
      const ingestId = await st.runIds.ingest(ref2, doc2, gen);
      await vi.waitFor(
        async () => {
          const done = (await st.durable.raw.eventStore.read(visualizeId)).find(
            (e) => e.eventType === "EXECUTION_COMPLETED",
          );
          expect(done).toBeDefined();
        },
        { timeout: 60_000, interval: 100 },
      );
      expect(visualizeId).toMatch(/^h_[a-z2-7]{25}[aeimquy4]:visualize-/);
      expect(ingestId).toMatch(/^h_[a-z2-7]{25}[aeimquy4]:ingest-/);
      const stored = await st.db.owner.query(
        "SELECT ingest_execution_id AS i, visualize_execution_id AS v FROM documents WHERE id = $1",
        [doc2],
      );
      expect(stored.rows[0]).toEqual({ i: ingestId, v: visualizeId });
      const line = (await st.composed.ids.ensureUser(ref)).documentLineage(doc2);
      expect(line).toMatch(/^visuals-/);
      expect(line).not.toContain(doc2);

      // Suggest tags on the restarted stack (the first document).
      await new PgDocumentResults(st.app, st.fields).putSummary(ref, SUMMARY);
      expect(await st.composed.suggestTags.start(ref)).toEqual({ kind: "started", run: 1 });
      const tagsId = await st.runIds.suggestTags(ref, user.documentId, 1);
      expect(tagsId).toMatch(/^h_[a-z2-7]{25}[aeimquy4]:suggest-tags-/);
      const principal = { tenant: ref.tenantId, actor: ref.userId };
      await vi.waitFor(
        async () =>
          expect((await st.composed.app.runtime.loadState(tagsId, { principal }))?.status).toBe(
            "completed",
          ),
        { timeout: 60_000, interval: 200 },
      );

      // The control: new-format ids hold the handle and no plain id, the old-format chat still holds the user; before the erasure
      // the status row does link the handle to the user and the document, so the linking helper is not blind.
      const all = (await st.durable.raw.eventStore.listExecutions?.()) ?? [];
      user.executions = all.filter(
        (id) =>
          (id.includes(handle) || id.includes(user.userId)) &&
          !id.startsWith("__loom_ui_lineage__:"),
      );
      const fresh = user.executions.filter((id) => id.startsWith(`h_${handle}`));
      expect(fresh.length).toBeGreaterThanOrEqual(4); // two ingests, a visualize, suggest-tags
      for (const id of fresh) {
        expect(id).not.toMatch(UUID_ANYWHERE);
        for (const plain of [user.userId, user.documentId, doc2, user.chatId])
          expect(id).not.toContain(plain);
      }
      expect(user.executions.some((id) => id.startsWith(`u_${user.userId}`))).toBe(true);
      expect(
        await rowsLinkingHandleToIds(st.db.owner, handle, [user.userId, user.documentId]),
      ).toContain("public.read_model_state");

      expect((await eraseMe(st, login.cookie)).status).toBe(202);
      await waitErased(st, user.userId, 120_000);
      await assertErased(st, user, { tenantGone: true }); // includes 3b (the handle's key) and 3c (no row holds the handle with a plain id)
      const ids = [user.userId, user.documentId, doc2, user.chatId];
      expect(await rowsLinkingHandleToIds(st.db.owner, handle, ids)).toEqual([]);
      // The second document's id (a run of the restarted stack) is nowhere.
      expect((await scanTables(st.db.owner, [doc2])).hits).toEqual([]);
    },
    WAIT,
  );
});

describe.skipIf(!PG_URL)(
  "opaque ids phase 2: the chat flows, end to end (needs DOCMIND_TEST_PG_URL)",
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
    const HANDLE = "[a-z2-7]{25}[aeimquy4]";
    const TOKEN = "[a-z2-7]{51}[aq]";

    /** Waits for the visuals head of a turn: the line resolves, so the turn run committed. */
    async function lineageHead(st: IngestStack, line: string) {
      const lineage = visualsLineage({
        events: st.durable.storage.eventStore,
        content: st.composed.lineageContent,
        keys: st.keys,
        subjectOf: subjectOfExecution,
      });
      await vi.waitFor(async () => expect((await lineage.resolveLatest(line)).ok).toBe(true), {
        timeout: 60_000,
        interval: 100,
      });
      return lineage;
    }
    /** The ord of a chat's one assistant reply (the turn the visuals belong to). */
    const replyOrd = async (st: IngestStack, cookie: string, chatId: string) =>
      Number(
        ListMessagesResponse.parse(
          await (await st.chatReq(cookie, "GET", `/api/chats/${chatId}/messages`)).json(),
        ).items.find((m) => m.role === "assistant")?.id,
      );

    it(
      "a new chat: the conversation, the title and the turn visuals are opaque (across a cold restart); erasing leaves nothing linkable",
      async () => {
        const first = track(await startIngestStack({ chat: true, visuals: true }));
        stubPaymentVisuals(first.visualsClaude as FakeAnthropic);
        const login = await first.signUpAndLogIn("chatids@example.com");
        const user = await seedUser(first, login, "chatids@example.com"); // a chat turn with a citation and a title, on a stack with visuals on
        expect(user.chatFormat).toBe("opaque");
        const who = { tenantId: user.tenantId, userId: user.userId };
        const ids = await first.runIds.chat(who, user.chatId);
        expect(ids?.format).toBe("opaque");
        const ord = await replyOrd(first, login.cookie, user.chatId);
        const line = ids?.turnExperienceId(ord) as string;
        await lineageHead(first, line);
        const handle = new RegExp(`^h_(${HANDLE})`).exec(
          ids?.conversationId() as string,
        )?.[1] as string;

        // A cold restart: the chat continues (recovery and the cache warm-up read the new ids), a second turn is answered and titled once.
        await first.close({ keepDb: true });
        stacks.splice(stacks.indexOf(first), 1);
        const st = track(
          await startIngestStack({
            chat: true,
            visuals: true,
            resume: { db: first.db, kek: first.kek, root: first.root },
          }),
        );
        stubPaymentVisuals(st.visualsClaude as FakeAnthropic);
        expect(st.composed.ids.cached(user.userId)?.handle).toBe(handle); // warmed at boot
        const history = ListMessagesResponse.parse(
          await (
            await st.chatReq(login.cookie, "GET", `/api/chats/${user.chatId}/messages`)
          ).json(),
        );
        expect(history.items.map((m) => m.role)).toEqual(["user", "assistant"]);
        expect(history.items.find((m) => m.role === "assistant")?.hasVisuals).toBe(true); // the head reads back through the opaque line

        // Every id of the chat, before the erasure: built from the handle and tokens, no uuid anywhere.
        const all = (await st.durable.raw.eventStore.listExecutions?.()) ?? [];
        const conv = all.filter((id) => id.startsWith(`h_${handle}.c-`));
        const title = all.filter((id) => id.startsWith(`h_${handle}:chat-title-`));
        const turn = all.filter((id) => id.startsWith(`h_${handle}:visualize-turn-`));
        const lines = all.filter((id) => id.startsWith("__loom_ui_lineage__:turnvisuals-"));
        expect(conv.length).toBeGreaterThanOrEqual(1);
        expect(title).toHaveLength(1);
        expect(turn.length).toBeGreaterThanOrEqual(1);
        expect(lines).toHaveLength(1);
        expect(conv[0]).toMatch(new RegExp(`^h_${HANDLE}\\.c-${TOKEN}(~\\d+)?$`));
        expect(title[0]).toMatch(new RegExp(`^h_${HANDLE}:chat-title-${TOKEN}$`));
        expect(turn[0]).toMatch(new RegExp(`^h_${HANDLE}:visualize-turn-${TOKEN}-\\d+(-r\\d+)?$`));
        expect(lines[0]).toMatch(
          new RegExp(`^__loom_ui_lineage__:turnvisuals-${HANDLE}-${TOKEN}-\\d+$`),
        );
        for (const id of [...conv, ...title, ...turn, ...lines]) {
          expect(id).not.toMatch(UUID_ANYWHERE);
          for (const plain of [user.userId, user.chatId, user.documentId, user.tenantId])
            expect(id).not.toContain(plain);
        }
        expect(all.some((id) => id.startsWith(`u_${user.userId}.c-`))).toBe(false); // no old-format chat execution was made
        // The control: before the erasure the status rows link the handle to the user, so the linking helper is not blind.
        expect(
          await rowsLinkingHandleToIds(st.db.owner, handle, [user.userId, user.chatId]),
        ).toContain("public.read_model_state");

        user.executions = all.filter(
          (id) => namesUserForTest(id, user, handle) && !id.startsWith("__loom_ui_lineage__:"),
        );
        expect((await eraseMe(st, login.cookie)).status).toBe(202);
        await waitErased(st, user.userId, 120_000);
        await assertErased(st, user, { tenantGone: true });
        expect(
          await rowsLinkingHandleToIds(st.db.owner, handle, [
            user.userId,
            user.chatId,
            user.documentId,
          ]),
        ).toEqual([]);
        expect(
          (await scanTables(st.db.owner, [user.chatId])).hits.filter(
            (h) => h.table !== "public.erasure_requests",
          ),
        ).toEqual([]);
        // The turn's line is erased with the handle's key.
        const lineage = visualsLineage({
          events: st.durable.storage.eventStore,
          content: st.composed.lineageContent,
          keys: st.keys,
          subjectOf: subjectOfExecution,
        });
        expect(await lineage.resolveLatest(line)).toMatchObject({
          ok: false,
          refusal: { kind: "refused", finding: { code: "line-erased" } },
        });
      },
      WAIT,
    );

    it(
      "a mixed history: an old chat continues in the old format beside a new chat; erasing removes both",
      async () => {
        const first = track(await startIngestStack({ chat: true, visuals: true }));
        stubPaymentVisuals(first.visualsClaude as FakeAnthropic);
        const login = await first.signUpAndLogIn("mixed@example.com");
        // The old chat, as every chat before this release: seeded with a turn, a title and (visuals on) a turn visuals line under `u_`.
        const user = await seedUser(first, login, "mixed@example.com", { chat: "legacy" });
        expect(user.chatFormat).toBe("legacy");
        const who = { tenantId: user.tenantId, userId: user.userId };
        const oldIds = await first.runIds.chat(who, user.chatId);
        expect(oldIds?.format).toBe("legacy");
        expect(oldIds?.conversationId()).toBe(`u_${user.userId}.c-${user.chatId}`);
        const oldOrd = await replyOrd(first, login.cookie, user.chatId);
        await lineageHead(first, oldIds?.turnExperienceId(oldOrd) as string);

        // A new chat of the same user, then a cold restart.
        const fresh = ChatSessionDto.parse(
          await (await first.chatReq(login.cookie, "POST", "/api/chats", {})).json(),
        );
        user.moreChatIds = [fresh.id];
        await first.close({ keepDb: true });
        stacks.splice(stacks.indexOf(first), 1);
        const st = track(
          await startIngestStack({
            chat: true,
            visuals: true,
            resume: { db: first.db, kek: first.kek, root: first.root },
          }),
        );
        stubPaymentVisuals(st.visualsClaude as FakeAnthropic);
        const claude = st.claude;
        if (!claude) throw new Error("no fake Claude");
        scriptChat(claude, () => ({
          stream: { steps: [{ text: "More." }, { stop: "end_turn" }] },
        }));
        const ask = async (chatId: string) => {
          const stream = await st.openChat(login.cookie, chatId);
          try {
            const sent = await st.chatReq(login.cookie, "POST", `/api/chats/${chatId}/messages`, {
              text: "And then?",
            });
            expect(sent.status).toBe(202);
            await collectUntil(
              stream,
              (f) => isReply(f) && (f.data as { text?: string }).text === "More.",
            );
          } finally {
            stream.close();
          }
        };
        const userTurns = async () =>
          ListMessagesResponse.parse(
            await (
              await st.chatReq(login.cookie, "GET", `/api/chats/${user.chatId}/messages`)
            ).json(),
          ).items.filter((m) => m.role === "user").length;
        const oldEvents = async () =>
          (await st.durable.raw.eventStore.read(oldIds?.conversationId() as string)).length;
        const [turnsBefore, eventsBefore] = [await userTurns(), await oldEvents()];
        await ask(user.chatId); // the old chat continues
        await ask(fresh.id); // the new chat answers

        const all = (await st.durable.raw.eventStore.listExecutions?.()) ?? [];
        // The old chat continued after the restart, in the old format: one more user message, and its own `u_` conversation grew.
        expect(await userTurns()).toBe(turnsBefore + 1);
        expect(await oldEvents()).toBeGreaterThan(eventsBefore);
        expect(eventsBefore).toBeGreaterThan(0);
        const newIds = await st.runIds.chat(who, fresh.id);
        expect(newIds?.format).toBe("opaque");
        const handle = new RegExp(`^h_(${HANDLE})`).exec(
          newIds?.conversationId() as string,
        )?.[1] as string;
        expect(all.some((id) => new RegExp(`^h_${handle}\\.c-${TOKEN}(~\\d+)?$`).test(id))).toBe(
          true,
        );
        // no h_ execution belongs to the old chat and no u_ execution to the new one
        // the control for the allow-listed residual: the old chat's turn visuals line exists, under the old id, and only for the old chat
        expect(
          all.filter((id) =>
            id.startsWith(`__loom_ui_lineage__:turnvisuals-${user.userId}-${user.chatId}-`),
          ).length,
        ).toBeGreaterThanOrEqual(1);
        expect(
          all.filter((id) =>
            id.startsWith(`__loom_ui_lineage__:turnvisuals-${user.userId}-${fresh.id}`),
          ),
        ).toEqual([]);
        const userIds = st.composed.ids.cached(user.userId);
        if (!userIds) throw new Error("the new chat should have minted the user's handle");
        const oldChatToken = opaqueBuilders(userIds, user.chatId)
          .conversationId()
          .split(".c-")[1] as string;
        expect(oldChatToken).toMatch(new RegExp(`^${TOKEN}$`)); // the control: the token the old chat WOULD have under h_ is a real token
        expect(
          all.filter(
            (id) => id.startsWith("h_") && id.includes(".c-") && id.includes(oldChatToken),
          ),
        ).toEqual([]);
        expect(
          all.filter((id) => id.startsWith(`u_${user.userId}`) && id.includes(fresh.id)),
        ).toEqual([]);
        expect(all.some((id) => id.startsWith(`u_${user.userId}:chat-title-${user.chatId}`))).toBe(
          true,
        ); // the old chat's title stayed old
        expect(all.filter((id) => id.startsWith(`h_${handle}:chat-title-`))).toHaveLength(1); // one title for the new chat, none doubled for the old one

        user.executions = all.filter(
          (id) => namesUserForTest(id, user, handle) && !id.startsWith("__loom_ui_lineage__:"),
        );
        expect((await eraseMe(st, login.cookie)).status).toBe(202);
        await waitErased(st, user.userId, 120_000);
        await assertErased(st, user, { tenantGone: true }); // legacy chat: its lineage line is the allow-listed residual (Who.legacyChats)
        expect(
          await rowsLinkingHandleToIds(st.db.owner, handle, [user.userId, user.chatId, fresh.id]),
        ).toEqual([]);
      },
      WAIT,
    );

    it(
      "a chat parked mid-turn when the erasure starts: the stop closes the h_ conversation and the erasure completes with nothing linkable",
      async () => {
        // The first stop is swallowed so the turn is still running when the eraser first asks Loom to shred (outcome "parked"); the stop it
        // repeats after the park is the real one (the way `parkedErasure` of erasure.resume.e2e.pg.test.ts does it).
        const outcomes: string[] = [];
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
            const r = await deps.eraseSubject(userId);
            outcomes.push(r.outcome);
            return r;
          },
        });
        const first = track(await startIngestStack({ chat: true, wrapErasure: wrap }));
        const claude = first.claude;
        if (!claude) throw new Error("no fake Claude");
        const login = await first.signUpAndLogIn("parked@example.com");
        const user = await seedUser(first, login, "parked@example.com");
        expect(user.chatFormat).toBe("opaque");
        scriptChat(claude, () => ({
          stream: {
            steps: [{ text: "Due " }, { hold: true }, { text: "now." }, { stop: "end_turn" }],
          },
        }));
        const sent = await first.chatReq(
          login.cookie,
          "POST",
          `/api/chats/${user.chatId}/messages`,
          { text: "Hold on" },
        );
        expect(sent.status).toBe(202);
        const gate = await claude.streamHold(); // the model call is under way
        const handle = handleOfExecutions(user.executions) as string;
        try {
          expect((await eraseMe(first, login.cookie)).status).toBe(202);
          await waitErased(first, user.userId, 120_000);
        } finally {
          gate.release();
        }
        user.executions = ((await first.durable.raw.eventStore.listExecutions?.()) ?? []).filter(
          (id) => namesUserForTest(id, user, handle) && !id.startsWith("__loom_ui_lineage__:"),
        );
        expect(outcomes).toContain("parked"); // the control: the shred really parked behind the running h_ turn
        await assertErased(first, user, { tenantGone: true });
        expect(
          await rowsLinkingHandleToIds(first.db.owner, handle, [user.userId, user.chatId]),
        ).toEqual([]);
        // The stop repeated after the park cancels only under live subjects: no denial naming the actor was written on the shredded h_ stream.
        expect(await deniedOnHandle(first, handle)).toBe(0);
      },
      WAIT,
    );
  },
);

/** Whether an execution id names the user (the UUID) or the handle: the executions to judge after the erasure. */
const namesUserForTest = (id: string, user: { userId: string }, handle: string) =>
  id.includes(user.userId) || id.includes(handle);
