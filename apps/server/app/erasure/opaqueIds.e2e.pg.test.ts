import { rmSync } from "node:fs";
import type { FakeAnthropic } from "@docmind/llm-anthropic/testing";
import { afterAll, describe, expect, it } from "vitest";
import { vi } from "vitest";
import { DOC } from "../chats/e2eSupport";
import { PG_URL } from "../db/testSupport";
import { type IngestStack, startIngestStack } from "../documents/ingestStack";
import { PgDocumentResults } from "../flows/ingest-document/pgResults";
import { commitPlan, visualsLineage } from "../flows/visualize-document/lineage";
import { aPlan } from "../flows/visualize-document/testing";
import { subjectOfExecution } from "../subject";
import {
  assertErased,
  eraseMe,
  rowsLinkingHandleToIds,
  scanTables,
  seedUser,
  waitErased,
} from "./e2eSupport";

const WAIT = 300_000;
const UUID_ANYWHERE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const CHUNK_ID = /\[\[([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\]\]/;

/** A `visuals` model that finds one figure in whatever document it is shown and plans a KeyFigure for it. */
function stubVisuals(claude: FakeAnthropic) {
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
      // Seeded on a chat-only stack: a chat turn's visuals lineage is still old-format until phase 2, and is judged by its own tests.
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
      stubVisuals(st.visualsClaude as FakeAnthropic);
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
