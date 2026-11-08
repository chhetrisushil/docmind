import { randomUUID } from "node:crypto";
import { VisualizeTurnResponse } from "@docmind/contracts";
import { ExecutionAlreadyExistsError, type WorkflowRuntime } from "@loom/workflow-runtime";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PG_URL } from "../db/testSupport";
import { ALICE, BOB } from "../documents/testHarness";
import { visualizeTurnFlow } from "../flows/visualize-turn/flow";
import { UserRateLimit } from "../flows/visualize-turn/limiter";
import type { TurnRead } from "../flows/visualize-turn/readTurn";
import { type VisualizeStart, loomTurnStarter } from "../flows/visualize-turn/start";
import { type ChatHarness, seedChat, startChatServer } from "./testHarness";

const CITED: TurnRead = {
  status: "complete",
  retrieved: ["k"],
  citations: [{ passageId: "k", documentId: randomUUID() }],
};

describe.skipIf(!PG_URL)(
  "POST /api/chats/:id/turns/:ord/visualize (needs DOCMIND_TEST_PG_URL)",
  () => {
    let h: ChatHarness;
    const state = {
      turn: CITED as TurnRead | null,
      start: { kind: "started", rerun: 1 } as VisualizeStart,
      limit: new UserRateLimit(10),
    };
    const visualize = vi.fn(async () => state.start);
    const read = vi.fn(async () => state.turn);
    beforeAll(async () => {
      h = await startChatServer({
        visualize: {
          starter: { visualize },
          turn: { read },
          limiter: { tryAcquire: (u) => state.limit.tryAcquire(u) },
        },
      });
    });
    afterAll(async () => void (await h.close()));
    beforeEach(() => {
      state.limit = new UserRateLimit(10); // each test starts with a fresh limiter, whatever ran before it
      state.turn = CITED;
      state.start = { kind: "started", rerun: 1 };
    });
    const post = (user: string, chat: string, ord: string | number) =>
      h.req(user, "POST", `/api/chats/${chat}/turns/${ord}/visualize`);
    const code = async (res: Response) =>
      ((await res.json()) as { error?: { code?: string } }).error?.code;

    it("answers 202 for a complete, cited answer of the caller's chat, and starts one run", async () => {
      state.limit = new UserRateLimit(10);
      visualize.mockClear();
      const id = await seedChat(h, ALICE);
      const res = await post("alice", id, 4);
      expect([res.status, VisualizeTurnResponse.parse(await res.json())]).toEqual([
        202,
        { started: true },
      ]);
      const turnRef = { tenantId: ALICE.tenantId, userId: ALICE.userId, chatId: id, ord: 4 };
      expect(visualize).toHaveBeenCalledWith(turnRef);
      expect(read).toHaveBeenCalledWith(turnRef); // the turn is read for the caller's own tenant, user and chat
    });

    it("answers 404 for another user's chat, an unknown or deleted chat and a malformed ord, and starts nothing", async () => {
      visualize.mockClear();
      const id = await seedChat(h, ALICE);
      expect((await post("bob", id, 4)).status).toBe(404);
      expect((await post("alice", randomUUID(), 4)).status).toBe(404);
      for (const bad of ["0", "-1", "01", "x", "1.5", "1000000000000000"])
        expect((await post("alice", id, bad)).status, bad).toBe(404);
      await h.req("alice", "DELETE", `/api/chats/${id}`);
      expect((await post("alice", id, 4)).status).toBe(404);
      expect(visualize).not.toHaveBeenCalled();
    });

    it("answers 409 not_visualizable for a turn that is not a complete, cited answer, or while the role is off", async () => {
      visualize.mockClear();
      const id = await seedChat(h, ALICE);
      for (const turn of [
        null,
        { ...CITED, citations: [] },
        { ...CITED, status: "interrupted" as const },
        { ...CITED, status: "failed" as const },
      ]) {
        state.turn = turn;
        const res = await post("alice", id, 4);
        expect([res.status, await code(res)]).toEqual([409, "not_visualizable"]);
      }
      expect(visualize).not.toHaveBeenCalled();
      state.turn = CITED;
      state.start = { kind: "disabled" };
      const off = await post("alice", id, 4);
      expect([off.status, await code(off)]).toEqual([409, "not_visualizable"]);
      state.start = { kind: "started", rerun: 1 };
    });

    it("answers 409 not_visualizable, with its own message, for a turn further back than the lookback", async () => {
      visualize.mockClear();
      state.turn = { status: "too_old", retrieved: [], citations: [] };
      const id = await seedChat(h, ALICE);
      const res = await post("alice", id, 4);
      const body = (await res.json()) as { error?: { code?: string; message?: string } };
      expect([res.status, body.error?.code]).toEqual([409, "not_visualizable"]);
      expect(body.error?.message).toContain("too far back");
      expect(visualize).not.toHaveBeenCalled();
    });

    it("a 409 consumes a rate-limit slot but a 404 does not", async () => {
      state.limit = new UserRateLimit(1);
      const id = await seedChat(h, ALICE);
      for (const bad of ["0", "x"]) expect((await post("alice", id, bad)).status).toBe(404);
      expect((await post("alice", randomUUID(), 4)).status).toBe(404);
      expect((await post("bob", id, 4)).status).toBe(404);
      state.turn = null;
      expect((await post("alice", id, 4)).status).toBe(409); // takes the one slot
      state.turn = CITED;
      expect((await post("alice", id, 4)).status).toBe(429); // so the next is limited
    });

    it("answers 409 visualize_running while a run of the turn is in flight", async () => {
      state.start = { kind: "running" };
      const id = await seedChat(h, ALICE);
      const res = await post("alice", id, 4);
      expect([res.status, await code(res)]).toEqual([409, "visualize_running"]);
      state.start = { kind: "started", rerun: 1 };
    });

    it("answers 429 with retry-after on the 11th request in a minute, per user", async () => {
      state.limit = new UserRateLimit(10);
      const id = await seedChat(h, ALICE);
      for (let i = 0; i < 10; i++) expect((await post("alice", id, 4)).status).toBe(202);
      const limited = await post("alice", id, 4);
      expect(limited.status).toBe(429);
      expect(limited.headers.get("retry-after")).toBe("60");
      const mine = await seedChat(h, BOB);
      expect((await post("bob", mine, 4)).status).toBe(202); // another user is not limited by alice
    });
  },
);

describe.skipIf(!PG_URL)(
  "POST .../visualize with the real turn starter (needs DOCMIND_TEST_PG_URL)",
  () => {
    let h: ChatHarness;
    const start = vi.fn(async () => {
      throw new ExecutionAlreadyExistsError("taken");
    });
    beforeAll(async () => {
      const starter = loomTurnStarter(
        { start } as unknown as Pick<WorkflowRuntime, "start">,
        visualizeTurnFlow(),
        {
          enabled: () => true,
          tenantOf: async () => ALICE.tenantId,
          turn: { read: async () => CITED },
          backlog: () => 0,
          maxWaiting: 20,
          onError: () => {},
        },
      );
      h = await startChatServer({
        visualize: {
          starter,
          turn: { read: async () => CITED },
          limiter: { tryAcquire: () => true },
        },
      });
    });
    afterAll(async () => void (await h.close()));

    it("answers 409 visualize_running once all 999 re-run numbers are taken", async () => {
      const id = await seedChat(h, ALICE);
      const res = await h.req("alice", "POST", `/api/chats/${id}/turns/4/visualize`);
      const body = (await res.json()) as { error?: { code?: string } };
      expect([res.status, body.error?.code]).toEqual([409, "visualize_running"]);
      expect(start).toHaveBeenCalledTimes(999);
    });
  },
);
