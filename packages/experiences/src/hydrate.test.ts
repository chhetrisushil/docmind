import type { DocumentDto } from "@docmind/contracts";
import { describe, expect, it, vi } from "vitest";
import { INVOKE_ID, MAX_READS_PER_BATCH, type UiReaders, createInvoker } from "./invoker";
import { CHAT_LIST_CAP, CONTENT_CAP, LIST_CAP } from "./providers";
import { MAX_CONCURRENT_READS, createViews } from "./views-api";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const doc = (n: number): DocumentDto => ({
  id: id(n),
  title: "sentinel-title-0123456789",
  filename: "f.pdf",
  mime: "application/pdf",
  sizeBytes: 10,
  status: "ready",
  error: null,
  stats: null,
  summary: null,
  createdAt: "2026-10-01T10:00:00.000Z",
  updatedAt: "2026-10-01T10:00:00.000Z",
});
const readers = (over: Partial<UiReaders> = {}): UiReaders => ({
  documents: vi.fn(async () => ({ items: [doc(1)], truncated: false })),
  document: vi.fn(async (a) => (a.id === id(1) ? doc(1) : null)),
  content: vi.fn(async () => ({ items: [], more: false })),
  source: vi.fn(async () => null),
  chats: vi.fn(async () => []),
  ...over,
});
const views = (onFinding = vi.fn()) =>
  createViews({ placeholderKey: "k".repeat(32), revisionKey: "r".repeat(32), onFinding });
const req = (
  name: "library" | "detail" | "sessions",
  handle: string,
  params: Record<string, string | number> = {},
) => {
  const p = views().payload(name, "web");
  return { experienceId: p.experienceId, versionHash: p.versionHash, handle, params };
};

describe("hydrate", () => {
  it("serves a handle by calling a reader, shaping the answer, and checking it against the widget's kind", async () => {
    const r = readers();
    const [out] = await views().hydrate("library", [req("library", "doc-total")], r, "user-1");
    expect(out).toEqual({ state: "ready", value: { value: 1, label: "in your library" } });
    expect(r.documents).toHaveBeenCalledWith({ limit: 200, status: "all" });
  });

  it("handles that share a step share one read", async () => {
    const r = readers();
    const results = await views().hydrate(
      "library",
      ["doc-total", "doc-ready", "ingest"].map((h) => req("library", h)),
      r,
      "user-1",
    );
    expect(results.map((x) => x.state)).toEqual(["ready", "ready", "ready"]);
    expect(r.documents).toHaveBeenCalledTimes(1);
  });

  it("a parameter overrides only what the step declares: status for the table, not for the counts", async () => {
    const r = readers();
    await views().hydrate("library", [req("library", "documents", { status: "failed" })], r, "u");
    expect(r.documents).toHaveBeenCalledWith({ limit: 200, status: "failed" });
    const r2 = readers();
    await views().hydrate(
      "library",
      [req("library", "doc-total", { status: "failed", limit: 5 })],
      r2,
      "u",
    );
    expect(r2.documents).toHaveBeenCalledWith({ limit: 200, status: "all" });
  });

  it("validates a parameter again, on the server: a bad status, id, upto or passage never reaches a reader", async () => {
    const r = readers();
    const bad = await views().hydrate(
      "detail",
      [
        req("detail", "doc-status", { id: "not-a-uuid" }),
        req("detail", "doc-content", { id: id(1), upto: 9999 }),
        req("detail", "doc-content", { id: id(1), passage: "x" }),
      ],
      r,
      "u",
    );
    expect(bad.map((x) => x.state)).toEqual(["error", "error", "error"]);
    expect(r.document).not.toHaveBeenCalled();
    expect(r.content).not.toHaveBeenCalled();
    const status = await views().hydrate(
      "library",
      [req("library", "documents", { status: "; drop table" })],
      readers(),
      "u",
    );
    expect(status[0]?.state).toBe("error");
  });

  it("doc-source resolves with the page's full param set (upto is ignored, not rejected)", async () => {
    const r = readers({
      source: vi.fn(async () => ({
        applicable: true as const,
        format: "md" as const,
        text: "# a",
        truncated: false,
      })),
    });
    const [out] = await views().hydrate(
      "detail",
      [req("detail", "doc-source", { id: id(1), upto: 20, passage: "" })],
      r,
      "u",
    );
    expect(out).toEqual({
      state: "ready",
      value: { applicable: true, format: "markdown", text: "# a" },
    });
    expect(r.source).toHaveBeenCalledWith({ id: id(1), passage: "" });
  });

  it("a document that is missing and a document that is not yours answer the same way, with a public finding that names no value", async () => {
    const r = readers({ document: vi.fn(async () => null) });
    const [a, b] = await views().hydrate(
      "detail",
      [req("detail", "doc-status", { id: id(1) }), req("detail", "doc-status", { id: id(9) })],
      r,
      "u",
    );
    expect(a).toEqual(b);
    expect(a?.state).toBe("error");
    expect(JSON.stringify(a)).not.toMatch(/sentinel|00000000-0000/);
  });

  it("a request for another version is refused as a version mismatch, and nothing is read", async () => {
    const r = readers();
    const [out] = await views().hydrate(
      "library",
      [{ ...req("library", "doc-total"), versionHash: "sha256:old" }],
      r,
      "u",
    );
    expect(out).toMatchObject({ state: "error", finding: { code: "version-mismatch" } });
    expect(r.documents).not.toHaveBeenCalled();
  });

  it("an unbound handle is unknown, and a published handle is never served", async () => {
    const [unknown] = await views().hydrate("library", [req("library", "nope")], readers(), "u");
    expect(unknown).toMatchObject({ state: "error" });
    const chat = views().payload("chat", "web");
    const [t] = await views().hydrate(
      "chat",
      [
        {
          experienceId: chat.experienceId,
          versionHash: chat.versionHash,
          handle: "transcript",
          params: {},
        },
      ],
      readers(),
      "u",
    );
    expect(t?.state).toBe("error");
  });

  it("logs only finding codes (never a message), and a reader that throws content-bearing text is not echoed", async () => {
    const onFinding = vi.fn();
    const r = readers({
      documents: vi.fn(async () => {
        throw new Error("sentinel-title-0123456789 exploded");
      }),
    });
    const [out] = await views(onFinding).hydrate("library", [req("library", "doc-total")], r, "u");
    expect(out?.state).toBe("error");
    expect(JSON.stringify(out)).not.toContain("sentinel");
    expect(onFinding).toHaveBeenCalled();
    for (const call of onFinding.mock.calls) {
      expect(call[0]).toBe("doc-total");
      expect(call[1]).toMatch(/^[a-z][a-z0-9-]{0,63}$/);
    }
  });

  it("refuses a batch over 32 whole", async () => {
    const many = Array.from({ length: 33 }, () => req("library", "doc-total"));
    const out = await views().hydrate("library", many, readers(), "u");
    expect(out.every((x) => x.state === "error")).toBe(true);
  });
});

const passage = (n: number) => ({
  passageId: id(1000 + n),
  ordinal: n,
  locator: { kind: "page" as const, page: 1 },
  headingPath: [],
  text: "t",
});
const chatDto = (n: number) => ({
  id: id(2000 + n),
  title: null,
  scope: "all" as const,
  createdAt: "2026-10-01T10:00:00.000Z",
  lastMessageAt: null,
  messageCount: 0,
});
const call = (r: UiReaders, target: string, args: Record<string, unknown>) =>
  createInvoker(r).invokeTransient(INVOKE_ID, { target, args });

describe("document.source", () => {
  it("reads through the source reader and maps null to notFound", async () => {
    const source = vi.fn(async () => ({
      applicable: true as const,
      format: "md" as const,
      text: "# x",
      truncated: false,
    }));
    await expect(
      call(readers({ source }), "document.source", { id: id(1), passage: "" }),
    ).resolves.toEqual({
      applicable: true,
      format: "md",
      text: "# x",
      truncated: false,
    });
    expect(source).toHaveBeenCalledWith({ id: id(1), passage: "" });
    await expect(
      call(readers({ source: async () => null }), "document.source", { id: id(1), passage: "" }),
    ).rejects.toMatchObject({ channel: "notFound" });
    await expect(
      call(readers(), "document.source", { id: id(1), passage: "x" }),
    ).rejects.toMatchObject({ channel: "invalidArgs" });
  });
});

describe("the invoker refuses what it did not declare", () => {
  const cases: [string, string, Record<string, unknown>][] = [
    ["documents.list", "a limit of zero", { limit: 0, status: "all" }],
    ["documents.list", "a limit over the cap", { limit: LIST_CAP + 1, status: "all" }],
    ["documents.list", "a fractional limit", { limit: 1.5, status: "all" }],
    ["documents.list", "an unknown status", { limit: 5, status: "x" }],
    ["documents.list", "an unknown argument", { limit: 5, status: "all", extra: 1 }],
    ["document.get", "an unknown argument", { id: id(1), extra: 1 }],
    ["document.content", "an upto of zero", { id: id(1), upto: 0, passage: "" }],
    ["document.content", "an upto over the cap", { id: id(1), upto: CONTENT_CAP + 1, passage: "" }],
    ["document.content", "a fractional upto", { id: id(1), upto: 2.5, passage: "" }],
    ["document.content", "a passage that is not an id", { id: id(1), upto: 5, passage: "x" }],
    ["document.content", "an unknown argument", { id: id(1), upto: 5, passage: "", extra: 1 }],
    ["chats.list", "a query over 100 characters", { q: "q".repeat(101) }],
    ["chats.list", "a query that is not text", { q: 5 }],
    ["chats.list", "an unknown argument", { q: "", extra: 1 }],
    ["nope", "an unknown target", {}],
  ];
  it.each(cases)("%s: %s never reaches a reader", async (target, _why, args) => {
    const r = readers();
    await expect(call(r, target, args)).rejects.toBeTruthy();
    for (const fn of [r.documents, r.document, r.content, r.chats])
      expect(fn).not.toHaveBeenCalled();
  });
  it("refuses another tool id", async () => {
    await expect(
      createInvoker(readers()).invokeTransient("other.tool", {
        target: "documents.list",
        args: {},
      }),
    ).rejects.toBeTruthy();
  });
  it("clips a reader's over-return to upto, but keeps a cited passage past it with what precedes it, within the cap", async () => {
    const items = Array.from({ length: 30 }, (_, i) => ({ passageId: id(100 + i) }) as never);
    const r = readers({ content: vi.fn(async () => ({ items, more: false })) });
    const out = async (passage: string) =>
      (await call(r, "document.content", { id: id(1), upto: 10, passage })) as {
        content: { items: unknown[]; more: boolean };
      };
    expect((await out("")).content.items).toHaveLength(10);
    const cited = await out(id(120));
    expect(cited.content.items).toHaveLength(21);
    expect(cited.content.more).toBe(true);
    expect((await out(id(5000))).content.items).toHaveLength(10); // a passage the reader did not return is not found
  });
  it("accepts the boundary values", async () => {
    const r = readers();
    await call(r, "documents.list", { limit: LIST_CAP, status: "all" });
    await call(r, "document.content", { id: id(1), upto: CONTENT_CAP, passage: "" });
    await call(r, "chats.list", { q: "q".repeat(100) });
    expect(r.documents).toHaveBeenCalledTimes(1);
    expect(r.content).toHaveBeenCalledTimes(1);
    expect(r.chats).toHaveBeenCalledTimes(1);
  });
  it("a long query and a big upto are refused through hydrate too", async () => {
    const r = readers();
    const out = await views().hydrate(
      "sessions",
      [req("sessions", "chats", { q: "q".repeat(101) })],
      r,
      "u",
    );
    expect(out[0]?.state).toBe("error");
    const out2 = await views().hydrate(
      "detail",
      [req("detail", "doc-content", { id: id(1), upto: CONTENT_CAP + 1 })],
      r,
      "u",
    );
    expect(out2[0]?.state).toBe("error");
    expect(r.chats).not.toHaveBeenCalled();
    expect(r.content).not.toHaveBeenCalled();
  });
});

describe("the caps hold even when a reader returns more", () => {
  it("documents: at most the limit, and truncated says so", async () => {
    const r = readers({
      documents: vi.fn(async () => ({
        items: Array.from({ length: LIST_CAP + 50 }, (_, i) => doc(i + 1)),
        truncated: false,
      })),
    });
    const out = (await call(r, "documents.list", { limit: LIST_CAP, status: "all" })) as {
      items: unknown[];
      truncated: boolean;
    };
    expect(out.items).toHaveLength(LIST_CAP);
    expect(out.truncated).toBe(true);
  });
  it("chats: at most CHAT_LIST_CAP rows reach the table", async () => {
    const r = readers({
      chats: vi.fn(async () => Array.from({ length: CHAT_LIST_CAP + 10 }, (_, i) => chatDto(i))),
    });
    const [out] = await views().hydrate("sessions", [req("sessions", "chats")], r, "u");
    expect((out as { value: { rows: unknown[] } }).value.rows).toHaveLength(CHAT_LIST_CAP);
  });
  it("content: at most upto passages, and more says so", async () => {
    const r = readers({
      content: vi.fn(async () => ({
        items: Array.from({ length: 30 }, (_, i) => passage(i)),
        more: false,
      })),
    });
    const out = (await call(r, "document.content", { id: id(1), upto: 20, passage: "" })) as {
      content: { items: unknown[]; more: boolean };
    };
    expect(out.content.items).toHaveLength(20);
    expect(out.content.more).toBe(true);
  });
});

describe("one request, one read per identical step", () => {
  it("the same input is read once per invoker; another input, or another invoker, reads again", async () => {
    const r = readers();
    const inv = createInvoker(r);
    const a = { target: "documents.list", args: { limit: LIST_CAP, status: "all" } };
    await Promise.all([
      inv.invokeTransient(INVOKE_ID, a),
      inv.invokeTransient(INVOKE_ID, { target: a.target, args: { ...a.args } }),
    ]);
    expect(r.documents).toHaveBeenCalledTimes(1);
    await inv.invokeTransient(INVOKE_ID, {
      target: a.target,
      args: { limit: LIST_CAP, status: "failed" },
    });
    expect(r.documents).toHaveBeenCalledTimes(2);
    await createInvoker(r).invokeTransient(INVOKE_ID, a);
    expect(r.documents).toHaveBeenCalledTimes(3);
  });
  it("each hydrate call reads afresh (no memory across requests)", async () => {
    const r = readers();
    const v = views();
    await v.hydrate("library", [req("library", "doc-total")], r, "u");
    await v.hydrate("library", [req("library", "doc-total")], r, "u");
    expect(r.documents).toHaveBeenCalledTimes(2);
  });
  it("a failed read is not remembered as a success", async () => {
    const documents = vi
      .fn()
      .mockRejectedValueOnce(new Error("x"))
      .mockResolvedValue({ items: [], truncated: false });
    const inv = createInvoker(readers({ documents }));
    const a = { target: "documents.list", args: { limit: LIST_CAP, status: "all" } };
    await expect(inv.invokeTransient(INVOKE_ID, a)).rejects.toBeTruthy();
    await expect(inv.invokeTransient(INVOKE_ID, a)).resolves.toBeTruthy();
  });
});

describe("findings reported by code only", () => {
  it("every reported code is in the public vocabulary, whatever failed", async () => {
    const onFinding = vi.fn();
    const v = views(onFinding);
    const r = readers({
      documents: vi.fn(async () => {
        throw new Error("sentinel-title-0123456789");
      }),
      document: vi.fn(async () => null),
    });
    await v.hydrate(
      "library",
      [req("library", "documents", { status: "; drop" }), req("library", "doc-total")],
      r,
      "u",
    );
    await v.hydrate("detail", [req("detail", "doc-status", { id: id(1) })], r, "u");
    expect(onFinding).toHaveBeenCalled();
    for (const c of onFinding.mock.calls) {
      expect(c).toHaveLength(2);
      expect(c[1]).toMatch(/^[a-z][a-z0-9-]{0,63}$/);
      expect(JSON.stringify(c)).not.toMatch(/sentinel|00000000-0000/);
    }
  });
});

describe("186c review follow-ups", () => {
  it("M1: a library load reads documents once, whatever the defaulted keys are", async () => {
    const r = readers();
    const v = views();
    await v.hydrate(
      "library",
      ["doc-total", "doc-ready", "ingest", "documents"].map((h) => req("library", h)),
      r,
      "u",
    );
    expect(r.documents).toHaveBeenCalledTimes(1);
    const inv = createInvoker(readers());
    const r2 = readers();
    const i2 = createInvoker(r2);
    await i2.invokeTransient(INVOKE_ID, { target: "documents.list", args: { limit: 200 } });
    await i2.invokeTransient(INVOKE_ID, {
      target: "documents.list",
      args: { limit: 200, status: "all" },
    });
    expect(r2.documents).toHaveBeenCalledTimes(1);
    expect(inv).toBeTruthy();
  });
  it("M7: an input that cannot be keyed is a rejected promise, not a throw", () => {
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    const big = { target: "documents.list", args: { limit: 5n } };
    for (const input of [cyc, big, { target: "documents.list", args: cyc }]) {
      let p: Promise<unknown> | undefined;
      expect(() => {
        p = createInvoker(readers()).invokeTransient(INVOKE_ID, input);
      }).not.toThrow();
      expect(p).toBeInstanceOf(Promise);
      p?.catch(() => undefined);
    }
  });
  it("M2: onFinding names only handles the view binds, and never client text", async () => {
    const onFinding = vi.fn();
    const v = views(onFinding);
    const evil = "sentinel-title-0123456789".repeat(40);
    const r = readers({
      documents: vi.fn(async () => {
        throw new Error("x");
      }),
    });
    await v.hydrate("library", [req("library", evil), req("library", "documents")], r, "u");
    expect(onFinding).toHaveBeenCalled();
    const handles = onFinding.mock.calls.map((c) => c[0]);
    expect(handles).toContain("documents");
    for (const h of handles)
      expect(["documents", "doc-total", "doc-ready", "ingest", "unbound"]).toContain(h);
    expect(JSON.stringify(onFinding.mock.calls)).not.toContain("sentinel");
  });
  it("M4: an unknown or prototype view name is an error per request, not a throw", async () => {
    const r = readers();
    for (const name of ["constructor", "__proto__", "toString", "nope"]) {
      const out = await views().hydrate(
        name as never,
        [req("library", "doc-total"), req("library", "ingest")],
        r,
        "u",
      );
      expect(out.map((x) => x.state)).toEqual(["error", "error"]);
    }
    expect(r.documents).not.toHaveBeenCalled();
  });
  it("M5: createInvoker is not part of the package's public surface", async () => {
    const pkg = await import("./index");
    expect("createInvoker" in pkg).toBe(false);
    expect("INVOKE_ID" in pkg).toBe(true);
  });
  it("M6: a capped list labels failed and processing counts as minimums", async () => {
    const mk = (status: "failed" | "parsing") => ({ ...doc(1), status });
    for (const [status, word] of [
      ["failed", "failed"],
      ["parsing", "processed"],
    ] as const) {
      const capped = readers({
        documents: vi.fn(async () => ({ items: [mk(status)], truncated: true })),
      });
      const [a] = await views().hydrate("library", [req("library", "ingest")], capped, "u");
      expect(JSON.stringify(a)).toMatch(/at least 1/i);
      expect(JSON.stringify(a)).toContain(word);
      const full = readers({
        documents: vi.fn(async () => ({ items: [mk(status)], truncated: false })),
      });
      const [b] = await views().hydrate("library", [req("library", "ingest")], full, "u");
      expect(JSON.stringify(b)).not.toMatch(/at least/i);
    }
  });
});

describe("the work one batch can cause is bounded", () => {
  const distinct = (n: number) =>
    Array.from({ length: n }, (_, i) => req("detail", "doc-content", { id: id(1), upto: i + 1 }));
  it("a 32-request batch of distinct reads starts at most MAX_READS_PER_BATCH reads and answers the rest as errors", async () => {
    const r = readers({ content: vi.fn(async () => ({ items: [], more: false })) });
    const results = await views().hydrate("detail", distinct(32), r, "user-1");
    expect(results).toHaveLength(32);
    expect(r.content).toHaveBeenCalledTimes(MAX_READS_PER_BATCH);
    expect(results.filter((x) => x.state === "error")).toHaveLength(32 - MAX_READS_PER_BATCH);
    expect(results.filter((x) => x.state === "ready")).toHaveLength(MAX_READS_PER_BATCH);
  });
  it("never has more than MAX_CONCURRENT_READS reads in flight", async () => {
    let inFlight = 0;
    let peak = 0;
    const r = readers({
      content: vi.fn(async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight--;
        return { items: [], more: false };
      }),
    });
    await views().hydrate("detail", distinct(32), r, "user-1");
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(MAX_CONCURRENT_READS);
  });
  it("identical reads share one read and cost no budget", async () => {
    const r = readers();
    const same = Array.from({ length: 32 }, () => req("library", "doc-total"));
    const results = await views().hydrate("library", same, r, "user-1");
    expect(r.documents).toHaveBeenCalledTimes(1);
    expect(results.every((x) => x.state === "ready")).toBe(true);
  });
});
