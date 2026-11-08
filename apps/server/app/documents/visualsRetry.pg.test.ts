import { randomUUID } from "node:crypto";
import { RetryVisualsResponse } from "@docmind/contracts";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FieldCrypto } from "../crypto/fields";
import { PG_URL } from "../db/testSupport";
import type { VisualsRerun } from "../flows/visualize-document/start";
import { UserRateLimit } from "../flows/visualize-turn/limiter";
import {
  ALICE,
  type DocumentHarness,
  generationOf,
  seedDoc,
  startDocumentServer,
  uploadAndAwaitTerminal,
} from "./testHarness";

describe.skipIf(!PG_URL)(
  "POST /api/documents/:id/visuals/retry (needs DOCMIND_TEST_PG_URL)",
  () => {
    let h: DocumentHarness;
    const state = {
      answer: { kind: "started", rerun: 1 } as VisualsRerun,
      limit: new UserRateLimit(10),
    };
    const rerun = vi.fn(async () => state.answer);
    beforeAll(async () => {
      h = await startDocumentServer({
        deps: (d) => ({
          ...d,
          visualize: {
            starter: { rerun },
            limiter: { tryAcquire: (u) => state.limit.tryAcquire(u) },
          },
        }),
      });
    });
    afterAll(async () => void (await h?.close()));
    beforeEach(() => {
      state.answer = { kind: "started", rerun: 1 };
      state.limit = new UserRateLimit(10);
      rerun.mockClear();
    });
    const post = (user: string, id: string, headers: Record<string, string> = {}) =>
      fetch(`${h.base}/api/documents/${id}/visuals/retry`, {
        method: "POST",
        headers: { "x-test-user": user, ...headers },
      });
    const code = async (res: Response) =>
      ((await res.json()) as { error?: { code?: string } }).error?.code;
    const readyDoc = (tag: string) =>
      uploadAndAwaitTerminal(h, "alice", `${tag}.txt`, `visuals retry ${tag}`, "ready");

    it("answers 202 for a ready document of the caller and re-runs its current generation", async () => {
      const id = await readyDoc("ok");
      const res = await post("alice", id);
      expect([res.status, RetryVisualsResponse.parse(await res.json())]).toEqual([
        202,
        { started: true },
      ]);
      expect(rerun).toHaveBeenCalledTimes(1);
      expect(rerun).toHaveBeenCalledWith(
        { tenantId: ALICE.tenantId, userId: ALICE.userId, documentId: id },
        await generationOf(h.owner, id),
      );
    });

    it("answers 404 for another user's document, an unknown, a malformed and a deleted one, and starts nothing", async () => {
      const id = await readyDoc("foreign");
      expect((await post("alice2", id)).status).toBe(404);
      expect((await post("bob", id)).status).toBe(404);
      expect((await post("alice", randomUUID())).status).toBe(404);
      expect((await post("alice", "not-a-uuid")).status).toBe(404);
      const gone = await readyDoc("gone");
      const del = await fetch(`${h.base}/api/documents/${gone}`, {
        method: "DELETE",
        headers: { "x-test-user": "alice" },
      });
      expect(del.status).toBe(204);
      expect((await post("alice", gone)).status).toBe(404);
      expect(rerun).not.toHaveBeenCalled();
    });

    it("answers 409 not_visualizable for a document that is not ready, and while the visuals role is off", async () => {
      const unready = await seedDoc(
        h.owner,
        h.app,
        new FieldCrypto(h.keys),
        ALICE,
        "f".repeat(64),
        600,
      );
      const res = await post("alice", unready);
      expect([res.status, await code(res)]).toEqual([409, "not_visualizable"]);
      expect(rerun).not.toHaveBeenCalled();
      const id = await readyDoc("off");
      state.answer = { kind: "disabled" };
      const off = await post("alice", id);
      expect([off.status, await code(off)]).toEqual([409, "not_visualizable"]);
    });

    it("answers 409 visualize_running while a run of the document is in flight", async () => {
      const id = await readyDoc("busy");
      state.answer = { kind: "running" };
      const res = await post("alice", id);
      expect([res.status, await code(res)]).toEqual([409, "visualize_running"]);
    });

    it("answers 429 with retry-after on the 11th request in a minute, per user; a 404 uses no slot", async () => {
      const id = await readyDoc("limit");
      for (let i = 0; i < 5; i++) expect((await post("alice", randomUUID())).status).toBe(404);
      for (let i = 0; i < 10; i++) expect((await post("alice", id)).status).toBe(202);
      const limited = await post("alice", id);
      expect(limited.status).toBe(429);
      expect(limited.headers.get("retry-after")).toBe("60");
      expect(rerun).toHaveBeenCalledTimes(10);
      const other = await readyDoc("limit2");
      expect((await post("alice2", other)).status).toBe(404); // another user (not the owner): not limited, just not found
    });

    it("is refused for a cross-origin post and for an anonymous caller", async () => {
      const id = await readyDoc("origin");
      const cross = await post("alice", id, { "sec-fetch-site": "cross-site" });
      expect([cross.status, await code(cross)]).toEqual([403, "cross_origin_request"]);
      const anon = await fetch(`${h.base}/api/documents/${id}/visuals/retry`, { method: "POST" });
      expect(anon.status).toBe(401);
      expect(rerun).not.toHaveBeenCalled();
    });
  },
);

describe.skipIf(!PG_URL)("a harness without the visuals retry has no such route", () => {
  it("the route is only mounted with a starter", async () => {
    const h = await startDocumentServer();
    try {
      const res = await fetch(`${h.base}/api/documents/${randomUUID()}/visuals/retry`, {
        method: "POST",
        headers: { "x-test-user": "alice" },
      });
      expect(res.status).toBe(404);
    } finally {
      await h.close();
    }
  });
});
