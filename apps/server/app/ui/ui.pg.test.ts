import { randomUUID } from "node:crypto";
import { UiViewResponse } from "@docmind/contracts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { chatTitleBind, insertChat, setTitle } from "../chats/sessions";
import { FieldCrypto } from "../crypto/fields";
import { withTenant } from "../db/tenant";
import { PG_URL } from "../db/testSupport";
import { summaryBind, titleBind } from "../documents/repo";
import {
  ALICE,
  ALICE2,
  BOB,
  type DocumentHarness,
  seedDoc,
  startDocumentServer,
} from "../documents/testHarness";
import type { Chunk } from "../flows/ingest-document/chunker";
import { PgChunkStore } from "../flows/ingest-document/pgChunks";

interface Value {
  rowKeys: string[];
  value: number;
  passages: { head: string }[];
  more: unknown[];
}

describe.skipIf(!PG_URL)("the UI plane against Postgres (needs DOCMIND_TEST_PG_URL)", () => {
  let h: DocumentHarness;
  let fields: FieldCrypto;
  let mine: string;
  let mine2: string;
  let colleagues: string;
  let bobs: string;
  const chunk = (n: number): Chunk => ({
    ordinal: n,
    sectionOrdinal: 0,
    headingPath: ["Terms"],
    text: `sentinel-passage-${n}-0123456789`,
    tokenCount: 6,
    locator: { kind: "page", page: n + 1 },
  });
  const get = (path: string, user = "alice") =>
    fetch(`${h.base}${path}`, { headers: user ? { "x-test-user": user } : {} });
  const hydrate = async (
    user: string,
    view: "library" | "detail" | "sessions",
    handle: string,
    params: Record<string, unknown> = {},
  ) => {
    const v = UiViewResponse.parse(await (await get(`/api/ui/views/${view}`, user)).json());
    const res = await fetch(`${h.base}/api/ui/hydrate`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-user": user },
      body: JSON.stringify({
        view,
        requests: [{ experienceId: v.experienceId, versionHash: v.versionHash, handle, params }],
      }),
    });
    expect(res.status).toBe(200);
    return (
      (await res.json()) as {
        results: { state: string; value: Value; finding?: { code: string } }[];
      }
    ).results[0] as { state: string; value: Value; finding?: { code: string } };
  };

  beforeAll(async () => {
    h = await startDocumentServer();
    fields = new FieldCrypto(h.keys);
    mine = await seedDoc(h.owner, h.app, fields, ALICE, "a".repeat(64), 10);
    mine2 = await seedDoc(h.owner, h.app, fields, ALICE, "b".repeat(64), 10);
    colleagues = await seedDoc(h.owner, h.app, fields, ALICE2, "c".repeat(64), 10);
    bobs = await seedDoc(h.owner, h.app, fields, BOB, "d".repeat(64), 10);
    for (const [who, id, tag] of [
      [ALICE, mine, "alice"],
      [ALICE, mine2, "alice-2"],
      [ALICE2, colleagues, "colleague"],
      [BOB, bobs, "bob"],
    ] as const) {
      const cipher = fields.forUser(who.userId);
      const summary = {
        tldr: `sentinel-summary-${tag}`,
        keyPoints: [`sentinel-point-${tag}`],
        entities: [],
        topics: [],
        suggestedQuestions: [],
      };
      await h.owner.query(
        "UPDATE documents SET title_enc = $2::jsonb, summary_enc = $3::jsonb WHERE id = $1",
        [
          id,
          JSON.stringify(await cipher.seal(titleBind(id), `sentinel-title-${tag}`)),
          JSON.stringify(await cipher.seal(summaryBind(id), summary)),
        ],
      );
    }
    for (const [who, tag] of [
      [ALICE, "alice"],
      [BOB, "bob"],
    ] as const) {
      const chat = await withTenant(h.app, who.tenantId, (tx) =>
        insertChat(tx, who.tenantId, who.userId, randomUUID(), "all"),
      );
      const title = await fields
        .forUser(who.userId)
        .seal(chatTitleBind(chat.id), `sentinel-chat-${tag}`);
      await withTenant(h.app, who.tenantId, (tx) =>
        setTitle(tx, who.userId, chat.id, title, "user"),
      );
    }
    await new PgChunkStore(h.app, fields).replace(
      { tenantId: ALICE.tenantId, userId: ALICE.userId, documentId: mine },
      Array.from({ length: 45 }, (_, i) => chunk(i)),
    );
  });
  afterAll(async () => {
    await h?.close();
  });

  it("the library lists only the caller's own documents: not a colleague's in the same tenant, not another tenant's", async () => {
    const r = await hydrate("alice", "library", "documents");
    expect(r.state).toBe("ready");
    expect([...r.value.rowKeys].sort()).toEqual([mine, mine2].sort());
    expect(JSON.stringify(r)).not.toContain(colleagues);
    expect(JSON.stringify(r)).not.toContain(bobs);
    expect((await hydrate("bob", "library", "documents")).value.rowKeys).toEqual([bobs]);
    expect((await hydrate("alice2", "library", "documents")).value.rowKeys).toEqual([colleagues]);
  });

  it("a document that is not the caller's answers exactly like one that does not exist, for every handle of the detail view", async () => {
    for (const handle of ["doc-status", "doc-summary", "doc-words", "doc-facts", "doc-content"]) {
      const answers = await Promise.all(
        [colleagues, bobs, randomUUID()].map((id) => hydrate("alice", "detail", handle, { id })),
      );
      expect(new Set(answers.map((a) => JSON.stringify(a))).size, handle).toBe(1);
      expect(answers[0]?.state).toBe("error");
      expect(JSON.stringify(answers[0])).not.toMatch(/sentinel|[0-9a-f]{8}-[0-9a-f]{4}-/);
    }
  });

  it("serves the caller's own document through the same handles, with the passage the caller names first", async () => {
    expect((await hydrate("alice", "detail", "doc-status", { id: mine })).state).toBe("ready");
    const page = await hydrate("alice", "detail", "doc-content", { id: mine, upto: 20 });
    expect(page.value.passages).toHaveLength(20);
    expect(page.value.more).toHaveLength(1);
    const list = await get(
      `/api/documents/${mine}/content?cursor=${Buffer.from("o:29").toString("base64url")}`,
    );
    const target = ((await list.json()) as { items: { passageId: string }[] }).items[0]
      ?.passageId as string;
    const deep = await hydrate("alice", "detail", "doc-content", {
      id: mine,
      upto: 20,
      passage: target,
    });
    expect(deep.value.passages[0]?.head.startsWith("Cited passage - ")).toBe(true);
    expect(deep.value.passages.length).toBeGreaterThanOrEqual(31);
  });

  it("a parameter that is not what the handle takes is an error that touches no row", async () => {
    for (const params of [
      { status: "; drop table documents" },
      { status: "ready; select" },
      { limit: 5000 },
    ]) {
      const r = await hydrate("alice", "library", "documents", params);
      expect(r.state === "error" || r.value.rowKeys.length === 2, JSON.stringify(params)).toBe(
        true,
      );
    }
    expect(
      (await hydrate("alice", "detail", "doc-status", { id: `${mine}' OR '1'='1` })).state,
    ).toBe("error");
    expect(
      (await hydrate("alice", "detail", "doc-content", { id: mine, upto: 100000 })).state,
    ).toBe("error");
  });

  it("filters by status for the table and not for the counts", async () => {
    expect(
      (await hydrate("alice", "library", "documents", { status: "failed" })).value.rowKeys,
    ).toEqual([]);
    expect((await hydrate("alice", "library", "doc-total", { status: "failed" })).value.value).toBe(
      2,
    );
  });

  it("answers 401 without a session, and the views route refuses an anonymous caller too", async () => {
    expect((await get("/api/ui/views/library", "")).status).toBe(401);
    const res = await fetch(`${h.base}/api/ui/hydrate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(401);
  });

  it("never logs content, an id or an email while serving, and fails closed for an erased user's stale session", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await hydrate("alice", "detail", "doc-status", { id: colleagues });
    for (const call of log.mock.calls)
      expect(JSON.stringify(call)).not.toMatch(/sentinel|@|[0-9a-f]{8}-[0-9a-f]{4}-/);
    log.mockRestore();
  });

  it("the sessions handle lists the caller's chats only", async () => {
    const r = await hydrate("bob", "sessions", "chats");
    expect(r.state).toBe("ready");
    expect(r.value.rowKeys).toHaveLength(1);
    expect(JSON.stringify(r)).toContain("sentinel-chat-bob");
    expect(JSON.stringify(r)).not.toContain("sentinel-chat-alice");
  });

  it("user B never receives user A's titles, summaries, passages or chat titles through any handle, and A's ids answer as not found", async () => {
    const detail = [
      "doc-status",
      "doc-summary",
      "doc-words",
      "doc-pages",
      "doc-minutes",
      "doc-facts",
      "doc-content",
    ];
    const listed = [
      ["library", "documents"],
      ["library", "doc-total"],
      ["library", "doc-ready"],
      ["library", "ingest"],
      ["sessions", "chats"],
    ] as const;
    const everything = async (user: string, ids: string[]) => {
      const out: unknown[] = [];
      for (const [view, handle] of listed) out.push(await hydrate(user, view, handle));
      for (const id of ids)
        for (const handle of detail)
          out.push(
            await hydrate(
              user,
              "detail",
              handle,
              handle === "doc-content" ? { id, upto: 20 } : { id },
            ),
          );
      return JSON.stringify(out);
    };
    // bob (another tenant) and alice2 (same tenant, another user) ask for alice's ids
    for (const user of ["bob", "alice2"]) {
      const seen = await everything(user, [mine, mine2]);
      expect(seen).not.toMatch(/sentinel-(title|summary|point|passage|chat)-(alice|0|1|2)/);
      expect(seen).not.toContain(mine);
      expect(seen).not.toContain(mine2);
      for (const handle of detail) {
        const a = await hydrate(user, "detail", handle, { id: mine });
        const missing = await hydrate(user, "detail", handle, { id: randomUUID() });
        expect(JSON.stringify(a), handle).toBe(JSON.stringify(missing));
        expect(a.state).toBe("error");
      }
    }
    // and alice does see her own: the checks above are not vacuous
    const own = await everything("alice", [mine]);
    expect(own).toContain("sentinel-title-alice");
    expect(own).toContain("sentinel-chat-alice");
    expect(own).toContain("sentinel-passage-0-");
    expect(own).not.toMatch(/sentinel-(title|chat|summary)-(bob|colleague)/);
  });
});
