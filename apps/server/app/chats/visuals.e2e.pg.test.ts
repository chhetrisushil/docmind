import { randomUUID } from "node:crypto";
import { ChatSessionDto, UiViewResponse, type UploadDocumentResponse } from "@docmind/contracts";
import type { FakeAnthropic } from "@docmind/llm-anthropic/testing";
import { afterAll, describe, expect, it, vi } from "vitest";
import { PG_URL } from "../db/testSupport";
import { type IngestStack, startIngestStack } from "../documents/ingestStack";
import { isTurnVisualizeExecution } from "../flows/visualize-turn/ids";
import { isVisualizeExecution } from "../status/model";
import { DOC, collectUntil, isReply, scriptChat } from "./e2eSupport";
import { assertNoPlaintext } from "./eventLogProof";

const LABEL = "Zebra-Quarterly-Takings";
const FIGURE_DOC = `${DOC} ${LABEL} reached 7391.25 in the last quarter.`;
const CHUNK_ID = /\[\[([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\]\]/;
const WAIT = 60_000;

/**
 * A `visuals` model that finds the figure in whatever it is shown while `state.extract` is on, and plans a KeyFigure bound
 * to the first offered fact. `state.calls` counts every request, so a test can say how many a step made.
 */
function stubVisuals(claude: FakeAnthropic, state: { extract: boolean; calls: number }) {
  claude.reply((body) => {
    state.calls++;
    const system = typeof body.system === "string" ? body.system : JSON.stringify(body.system);
    const text = JSON.stringify(body.messages);
    if (system.includes("You extract facts")) {
      const chunk = CHUNK_ID.exec(text)?.[1];
      if (!state.extract || !chunk || !text.includes(LABEL)) return { text: '{"facts":[]}' };
      return {
        text: JSON.stringify({
          facts: [{ kind: "figure", label: LABEL, value: 7391.25, unit: "USD", chunkIds: [chunk] }],
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
            label: LABEL,
            span: 4,
            props: {},
            binding: { capability: "fact-0", arguments: {}, path: "value", priority: "P0" },
          },
        ],
      }),
    };
  });
}

describe.skipIf(!PG_URL)("chat visuals end to end (needs DOCMIND_TEST_PG_URL)", () => {
  const stacks: IngestStack[] = [];
  afterAll(async () => {
    for (const s of stacks.splice(0)) await s.close();
  });

  async function ready(st: IngestStack, cookie: string) {
    const events = await st.events(cookie);
    try {
      const up = await st.upload(cookie, "report.txt", Buffer.from(FIGURE_DOC));
      expect(up.status).toBe(201);
      const documentId = ((await up.json()) as UploadDocumentResponse).document.id;
      await st.until(events, documentId, (s) => s === "ready" || s === "failed");
      const chunks = await st.db.owner.query("SELECT id FROM chunks WHERE document_id = $1", [
        documentId,
      ]);
      return { documentId, passageId: chunks.rows[0].id as string };
    } finally {
      events.close();
    }
  }

  /** Asks one question; the chat model answers with `answer(passageId)`. Resolves with the reply frame's data. */
  async function ask(st: IngestStack, cookie: string, chatId: string, text: string) {
    const stream = await st.openChat(cookie, chatId);
    try {
      const sent = await st.chatReq(cookie, "POST", `/api/chats/${chatId}/messages`, {
        text,
        messageId: randomUUID(),
      });
      expect(sent.status).toBe(202);
      const frames = await collectUntil(stream, isReply);
      return frames.find(isReply)?.data as {
        id: string;
        hasVisuals?: boolean;
        citations: unknown[];
      };
    } finally {
      stream.close();
    }
  }

  /** Waits until every visualize-document execution of the stack has ended: its planner call (if it makes one) is then behind us, so a call count taken now is stable. */
  const documentVisualsSettled = (st: IngestStack) =>
    vi.waitFor(
      async () => {
        const ids = ((await st.durable.raw.eventStore.listExecutions?.()) ?? []).filter(
          isVisualizeExecution,
        );
        expect(ids.length).toBeGreaterThan(0);
        for (const id of ids) {
          const log = await st.durable.raw.eventStore.read(id);
          expect(
            log.some(
              (e) => e.eventType === "EXECUTION_COMPLETED" || e.eventType === "EXECUTION_FAILED",
            ),
            id,
          ).toBe(true);
        }
      },
      { timeout: WAIT, interval: 50 },
    );

  /**
   * Records the ords the turn-settled listener is called with (the starter's `onSettled`, which compose.ts reaches through
   * the object, so wrapping it here sees every call). Install it before the question is asked.
   */
  const watchSettled = (st: IngestStack) => {
    const seen = new Set<number>();
    const turns = st.composed.turns;
    if (turns) {
      const original = turns.onSettled.bind(turns);
      turns.onSettled = (e) => {
        seen.add(e.ord);
        original(e);
      };
    }
    return seen;
  };

  /**
   * Waits until the settled listener has been called for this turn, then until its queued check has finished: a negative
   * assertion made after this is not vacuous. The signal is the listener call itself, not a poll of the history.
   */
  async function hookSettled(st: IngestStack, seen: Set<number>, ord: number) {
    expect(st.composed.turns).toBeDefined();
    await vi.waitFor(() => expect(seen.has(ord)).toBe(true), { timeout: WAIT, interval: 20 });
    await st.composed.turns?.idle();
  }

  const outcomeOf = async (
    st: IngestStack,
    who: { userId: string; tenantId: string },
    chatId: string,
    ord: number,
    rerun?: number,
  ) => {
    let outcome = "";
    // The turn run's id is in the chat's own format (a chat made through the API is opaque).
    const ids = await st.composed.chatIds.forRef({ ...who, chatId });
    if (!ids) throw new Error("no ids for the chat");
    await vi.waitFor(
      async () => {
        const end = (await st.durable.raw.eventStore.read(ids.turnExecutionId(ord, rerun))).find(
          (e) => e.eventType === "EXECUTION_COMPLETED",
        );
        expect(end).toBeDefined();
        outcome = (end?.payload as { output: { outcome: string } }).output.outcome;
      },
      { timeout: WAIT, interval: 50 },
    );
    return outcome;
  };

  const view = async (st: IngestStack, cookie: string, chatId: string, ord: number) =>
    fetch(`${st.base}/api/ui/chats/${chatId}/turns/${ord}/visuals?surface=web`, {
      headers: { cookie },
    });
  const hydrate = async (st: IngestStack, cookie: string, chatId: string, ord: number) => {
    const v = UiViewResponse.parse(await (await view(st, cookie, chatId, ord)).json());
    const res = await fetch(`${st.base}/api/ui/hydrate`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        turn: { chatId, ord },
        requests: v.inventory.handles.map((h) => ({
          experienceId: v.experienceId,
          versionHash: v.versionHash,
          handle: h.handle,
          params: {},
        })),
      }),
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { results: { state: string; value: unknown }[] }).results;
  };

  it(
    "a cited answer gets its visuals from the stored facts: hook, flow, visuals frame, hydrated widgets, the committed head re-served with no model call; then on demand",
    async () => {
      const st = await startIngestStack({ chat: true, visuals: true });
      stacks.push(st);
      const state = { extract: true, calls: 0 };
      stubVisuals(st.visualsClaude as FakeAnthropic, state);
      const ada = await st.signUpAndLogIn("ada@example.com");
      const { passageId } = await ready(st, ada.cookie); // visualize-document stores the fact during ingest
      await vi.waitFor(
        async () =>
          expect(
            (await st.db.owner.query("SELECT count(*)::int AS n FROM visual_facts")).rows[0].n,
          ).toBe(1),
        { timeout: WAIT },
      );
      await documentVisualsSettled(st); // the document flow's planner call is made before the chat's count starts
      scriptChat(st.claude as FakeAnthropic, () => ({
        text: `${LABEL} reached 7391.25 [[${passageId}]].`,
      }));
      const chat = ChatSessionDto.parse(
        await (await st.chatReq(ada.cookie, "POST", "/api/chats", {})).json(),
      );

      const before = state.calls;
      const stream = await st.openChat(ada.cookie, chat.id);
      await st.chatReq(ada.cookie, "POST", `/api/chats/${chat.id}/messages`, {
        text: "What were the takings?",
        messageId: randomUUID(),
      });
      const frames = await collectUntil(stream, (f) => f.event === "visuals");
      stream.close();
      const reply = frames.find(isReply)?.data as { id: string };
      const ord = Number(reply.id);
      expect(frames.find((f) => f.event === "visuals")?.data).toEqual({
        ord,
        outcome: "visualized",
      });
      expect(await outcomeOf(st, ada, chat.id, ord)).toBe("visualized");
      expect(state.calls - before).toBe(1); // the planner only: the stored fact covered the citation, no extraction

      // history now says so, and the widgets hydrate from the document's fact
      const page = (await (
        await st.chatReq(ada.cookie, "GET", `/api/chats/${chat.id}/messages`)
      ).json()) as { items: { id: string; role: string; hasVisuals?: boolean }[] };
      expect(page.items.filter((m) => m.role === "assistant").map((m) => m.hasVisuals)).toEqual([
        true,
      ]);
      const results = await hydrate(st, ada.cookie, chat.id, ord);
      expect(results[0]).toMatchObject({ state: "ready" });
      expect(JSON.stringify(results[0])).toContain("7391.25");

      // serving and hydrating again re-serve the committed head and never recompose it: no model call, counted before and after
      // (the flow-level replay claims are proven where they can be: `plan.test` re-composes from the recorded decision, `flow.test` re-starts a finished execution id)
      const served = state.calls;
      const headBefore = UiViewResponse.parse(
        await (await view(st, ada.cookie, chat.id, ord)).json(),
      ).versionHash;
      await hydrate(st, ada.cookie, chat.id, ord);
      expect(state.calls).toBe(served);

      // another user cannot read it
      const bob = await st.signUpAndLogIn("bob@example.com");
      expect((await view(st, bob.cookie, chat.id, ord)).status).toBe(404);

      // on demand: 202, a second run is numbered -r1, and the head is replaced idempotently
      const again = await st.chatReq(
        ada.cookie,
        "POST",
        `/api/chats/${chat.id}/turns/${ord}/visualize`,
      );
      expect(again.status).toBe(202);
      expect(await outcomeOf(st, ada, chat.id, ord, 1)).toBe("visualized");
      // the re-run decided the same plan from the same fact, so the head is kept as it was (the commit is idempotent), and still served
      const headAfter = UiViewResponse.parse(
        await (await view(st, ada.cookie, chat.id, ord)).json(),
      ).versionHash;
      expect(headAfter).toBe(headBefore);
      expect(JSON.stringify((await hydrate(st, ada.cookie, chat.id, ord))[0])).toContain("7391.25");

      // nothing readable is left in any raw log (the stack's whole event store), and the references stay readable
      const ids = (await st.durable.raw.eventStore.listExecutions?.()) ?? [];
      expect(ids.some(isTurnVisualizeExecution)).toBe(true);
      const raw = (await Promise.all(ids.map((id) => st.durable.raw.eventStore.read(id)))).flat();
      assertNoPlaintext(raw, [LABEL, "A headline figure"]); // each at least 12 characters, the helper's minimum
    },
    WAIT * 2,
  );

  it(
    "extracts from the turn's own chunks when no stored fact covers the citation, and seals them",
    async () => {
      const st = await startIngestStack({ chat: true, visuals: true });
      stacks.push(st);
      const state = { extract: false, calls: 0 }; // the document flow finds nothing
      stubVisuals(st.visualsClaude as FakeAnthropic, state);
      const ada = await st.signUpAndLogIn("ada@example.com");
      const { passageId } = await ready(st, ada.cookie);
      await documentVisualsSettled(st); // the document flow found nothing and has ended
      expect(
        (await st.db.owner.query("SELECT count(*)::int AS n FROM visual_facts")).rows[0].n,
      ).toBe(0);
      state.extract = true; // ...but the turn's extraction does
      scriptChat(st.claude as FakeAnthropic, () => ({
        text: `${LABEL} reached 7391.25 [[${passageId}]].`,
      }));
      const chat = ChatSessionDto.parse(
        await (await st.chatReq(ada.cookie, "POST", "/api/chats", {})).json(),
      );
      const before = state.calls;
      const reply = await ask(st, ada.cookie, chat.id, "What were the takings?");
      const ord = Number(reply.id);
      expect(await outcomeOf(st, ada, chat.id, ord)).toBe("visualized");
      expect(state.calls - before).toBe(2); // one extraction, one planner call
      const rows = await st.db.owner.query(
        "SELECT fact_enc::text AS t FROM turn_visual_facts WHERE chat_id = $1",
        [chat.id],
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0].t).not.toContain(LABEL);
      const ids = (await st.durable.raw.eventStore.listExecutions?.()) ?? [];
      expect(ids.some(isTurnVisualizeExecution)).toBe(true);
      const raw = (await Promise.all(ids.map((id) => st.durable.raw.eventStore.read(id)))).flat();
      assertNoPlaintext(raw, [LABEL, "A headline figure"]); // the fallback path's extraction and plan reach no raw log in the clear
      expect(JSON.stringify((await hydrate(st, ada.cookie, chat.id, ord))[0])).toContain("7391.25");
      // deleting the chat takes the facts with it once the row goes; the route refuses at once
      await st.chatReq(ada.cookie, "DELETE", `/api/chats/${chat.id}`);
      expect((await view(st, ada.cookie, chat.id, ord)).status).toBe(404);
    },
    WAIT * 2,
  );

  it(
    "starts nothing for an uncited answer and refuses it on demand; and starts nothing at all while the visuals role is off",
    async () => {
      const st = await startIngestStack({ chat: true, visuals: true });
      stacks.push(st);
      stubVisuals(st.visualsClaude as FakeAnthropic, { extract: true, calls: 0 });
      const ada = await st.signUpAndLogIn("ada@example.com");
      await ready(st, ada.cookie);
      scriptChat(st.claude as FakeAnthropic, () => ({ text: "I could not find that." })); // no [[marker]]
      const chat = ChatSessionDto.parse(
        await (await st.chatReq(ada.cookie, "POST", "/api/chats", {})).json(),
      );
      const settled = watchSettled(st);
      const reply = await ask(st, ada.cookie, chat.id, "What is the weather?");
      const ord = Number(reply.id);
      await hookSettled(st, settled, ord); // the hook's check for this turn has settled: a run would exist by now
      const res = await st.chatReq(
        ada.cookie,
        "POST",
        `/api/chats/${chat.id}/turns/${ord}/visualize`,
      );
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error?: { code?: string } }).error?.code).toBe(
        "not_visualizable",
      );
      const ids = (await st.durable.raw.eventStore.listExecutions?.()) ?? [];
      expect(ids.filter(isTurnVisualizeExecution)).toEqual([]);

      const off = await startIngestStack({ chat: true }); // no visuals role
      stacks.push(off);
      const bea = await off.signUpAndLogIn("bea@example.com");
      const { passageId } = await ready(off, bea.cookie);
      scriptChat(off.claude as FakeAnthropic, () => ({
        text: `Takings were 7391.25 [[${passageId}]].`,
      }));
      const offChat = ChatSessionDto.parse(
        await (await off.chatReq(bea.cookie, "POST", "/api/chats", {})).json(),
      );
      const offSettled = watchSettled(off);
      const offReply = await ask(off, bea.cookie, offChat.id, "What were the takings?");
      expect(offReply.citations).toHaveLength(1);
      await hookSettled(off, offSettled, Number(offReply.id)); // settled: the role is off, so the check ended without a start
      const offIds = (await off.durable.raw.eventStore.listExecutions?.()) ?? [];
      expect(offIds.filter(isTurnVisualizeExecution)).toEqual([]);
      const refused = await off.chatReq(
        bea.cookie,
        "POST",
        `/api/chats/${offChat.id}/turns/${Number(offReply.id)}/visualize`,
      );
      expect(refused.status).toBe(409);
    },
    WAIT * 2,
  );
});
