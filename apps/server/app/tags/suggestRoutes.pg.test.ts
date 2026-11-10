import { DocumentTagsResponse, SuggestTagsResponse } from "@docmind/contracts";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FieldCrypto } from "../crypto/fields";
import { PG_URL } from "../db/testSupport";
import {
  ALICE,
  BOB,
  type DocumentHarness,
  callApi,
  errorCode as code,
  seedNext,
  startDocumentServer,
} from "../documents/testHarness";
import { PgDocumentResults } from "../flows/ingest-document/pgResults";
import type { SuggestTagsStart } from "../flows/suggest-tags/start";

describe.skipIf(!PG_URL)("tag suggestion routes (needs DOCMIND_TEST_PG_URL)", () => {
  const state = { answer: { kind: "started", run: 1 } as SuggestTagsStart, allow: true };
  const start = vi.fn(async () => state.answer);
  let h: DocumentHarness;
  beforeAll(async () => {
    h = await startDocumentServer({
      suggest: { starter: { start }, limiter: { tryAcquire: () => state.allow } },
    });
  });
  afterAll(async () => void (await h?.close()));
  beforeEach(async () => {
    state.answer = { kind: "started", run: 1 };
    state.allow = true;
    start.mockClear();
    await h.owner.query("DELETE FROM tags");
    await h.owner.query("DELETE FROM documents");
  });
  const post = (user: string, path: string, body?: unknown) => callApi(h, user, "POST", path, body);
  const seed = async (who = ALICE, summary = true) => {
    const id = await seedNext(h, who);
    if (summary)
      await new PgDocumentResults(h.app, new FieldCrypto(h.keys)).putSummary(
        { ...who, documentId: id },
        { tldr: "t", keyPoints: [], entities: [], topics: [], suggestedQuestions: [] },
      );
    return id;
  };

  it("accept creates or reuses the tag, links it and removes it from the suggestions", async () => {
    const d = await seed();
    await h.tags.putSuggestions({ ...ALICE, documentId: d }, ["Finance", "Legal"]);
    const res = await post("alice", `/api/documents/${d}/tag-suggestions/accept`, {
      name: "finance",
    });
    const body = DocumentTagsResponse.parse(await res.json());
    expect([res.status, body.tags.map((t) => t.name), body.suggestedTags]).toEqual([
      200,
      ["finance"],
      ["Legal"],
    ]);
  });

  it("dismiss removes the name and leaves the tags alone", async () => {
    const d = await seed();
    await h.tags.putSuggestions({ ...ALICE, documentId: d }, ["Finance", "Legal"]);
    const res = await post("alice", `/api/documents/${d}/tag-suggestions/dismiss`, {
      name: "LEGAL",
    });
    const body = DocumentTagsResponse.parse(await res.json());
    expect([body.tags, body.suggestedTags]).toEqual([[], ["Finance"]]);
  });

  it("answers 404 for a document that is not yours or a malformed id, and 400 for a bad name", async () => {
    const mine = await seed();
    const theirs = await seed(BOB);
    for (const action of ["accept", "dismiss"]) {
      expect(
        (await post("alice", `/api/documents/${theirs}/tag-suggestions/${action}`, { name: "x" }))
          .status,
      ).toBe(404);
      expect(
        (await post("alice", `/api/documents/nope/tag-suggestions/${action}`, { name: "x" }))
          .status,
      ).toBe(404);
      const bad = await post("alice", `/api/documents/${mine}/tag-suggestions/${action}`, {
        name: "",
      });
      expect([bad.status, await code(bad)]).toEqual([400, "invalid_request"]);
    }
  });

  it("accept answers 409 tag_limit when the document holds 20 tags", async () => {
    const d = await seed();
    for (let i = 0; i < 20; i++) await h.tags.addToDocument(ALICE, d, `t${i}`);
    const res = await post("alice", `/api/documents/${d}/tag-suggestions/accept`, {
      name: "one more",
    });
    expect([res.status, await code(res)]).toEqual([409, "tag_limit"]);
  });

  it("refresh starts the flow for the caller's document and answers 202", async () => {
    const d = await seed();
    const res = await post("alice", `/api/documents/${d}/tag-suggestions/refresh`);
    expect([res.status, SuggestTagsResponse.parse(await res.json())]).toEqual([
      202,
      { started: true },
    ]);
    expect(start).toHaveBeenCalledWith({
      tenantId: ALICE.tenantId,
      userId: ALICE.userId,
      documentId: d,
    });
  });

  it("refresh answers 404 (not yours, malformed), 409 no_summary, 409 suggest_running, 409 suggest_unavailable and 429", async () => {
    const d = await seed();
    expect((await post("bob", `/api/documents/${d}/tag-suggestions/refresh`)).status).toBe(404);
    expect((await post("alice", "/api/documents/nope/tag-suggestions/refresh")).status).toBe(404);
    const bare = await seed(ALICE, false);
    const noSummary = await post("alice", `/api/documents/${bare}/tag-suggestions/refresh`);
    expect([noSummary.status, await code(noSummary)]).toEqual([409, "no_summary"]);
    expect(start).not.toHaveBeenCalled();
    state.answer = { kind: "running" };
    const running = await post("alice", `/api/documents/${d}/tag-suggestions/refresh`);
    expect([running.status, await code(running)]).toEqual([409, "suggest_running"]);
    state.answer = { kind: "disabled" };
    const off = await post("alice", `/api/documents/${d}/tag-suggestions/refresh`);
    expect([off.status, await code(off)]).toEqual([409, "suggest_unavailable"]);
    state.allow = false;
    const limited = await post("alice", `/api/documents/${d}/tag-suggestions/refresh`);
    expect([limited.status, limited.headers.get("retry-after"), await code(limited)]).toEqual([
      429,
      "60",
      "too_many_requests",
    ]);
  });
});
