import { unwrapTainted } from "@loom/classify";
import { describe, expect, it } from "vitest";
import { ChatToolInputError } from "./harness";
import { SECTION_MAX_CHARS, SECTION_MAX_PASSAGES, capSection, readEffects } from "./read";
import { DOC_A, DOC_B, P1, P2, P3, harness, passage, toolCtx, vectorScope } from "./testing";

function setup(opts: {
  known?: ReturnType<typeof passage>[];
  section?: ReturnType<typeof passage>[];
  related?: ReturnType<typeof passage>[];
  scope?: Parameters<typeof harness>[0];
}) {
  const h = harness(opts.scope ?? "all");
  const calls: { op: string; args: unknown[] }[] = [];
  const passages = {
    async read(...args: unknown[]) {
      calls.push({ op: "read", args });
      return new Map((opts.known ?? []).map((p) => [p.passageId, p]));
    },
    async section(...args: unknown[]) {
      calls.push({ op: "section", args });
      return opts.section ?? [];
    },
  };
  const retriever = {
    async related(...args: unknown[]) {
      calls.push({ op: "related", args });
      return opts.related ?? [];
    },
  };
  const e = readEffects({ ...h.deps, passages: passages as never, retriever: retriever as never });
  return { ...h, calls, e };
}

describe("related", () => {
  it("follows links from a passage the owner holds, as the call's own tenant and user, with the id lower-cased", async () => {
    const id = "0a0a0a01-0000-4000-8000-000000000001";
    const s = setup({
      known: [passage({ passageId: id })],
      related: [passage({ passageId: P2 })],
      scope: { documentIds: [DOC_A] },
    });
    const out = unwrapTainted(
      await s.e.related.execute({ passageId: id.toUpperCase(), kinds: ["entity"] }, toolCtx()),
    );
    expect((out as { passages: unknown[] }).passages).toHaveLength(1);
    expect(s.calls.find((c) => c.op === "related")?.args).toEqual([
      vectorScope,
      { documentIds: [DOC_A] },
      id,
      ["entity"],
    ]);
    expect(s.items.puts.map((p) => p.item.kind)).toEqual(["passages", "tool"]);
    expect(s.events[0]).toMatchObject({ kind: "tool", step: { name: "related", count: 1 } });
  });

  it("answers not_found identically for a missing passage, a foreign one and one outside the chat's scope", async () => {
    const missing = setup({ known: [] });
    const outside = setup({
      known: [passage({ documentId: DOC_B })],
      scope: { documentIds: [DOC_A] },
    });
    const answers = await Promise.all(
      [missing, outside].map(async (s) => ({
        out: unwrapTainted(await s.e.related.execute({ passageId: P1 }, toolCtx())),
        stored: s.items.puts.map((p) => p.item),
        searched: s.calls.some((c) => c.op === "related"),
      })),
    );
    expect(answers[0]).toEqual(answers[1]);
    expect(answers[0]).toEqual({
      out: { error: "not_found" },
      stored: [{ kind: "tool", body: { name: "related", label: "Not found", count: 0 } }],
      searched: false,
    });
  });

  it.each([
    ["a non-uuid id", { passageId: "p-1" }],
    ["an empty kinds list", { passageId: P1, kinds: [] }],
    ["an unknown kind", { passageId: P1, kinds: ["friend"] }],
    ["an extra key", { passageId: P1, documentId: DOC_A }],
  ])("refuses %s", async (_name, input) => {
    const s = setup({ known: [passage()] });
    await expect(s.e.related.execute(input, toolCtx())).rejects.toBeInstanceOf(ChatToolInputError);
    expect(s.calls).toEqual([]);
  });
});

describe("read_section", () => {
  const sec = (id: string, text: string, documentId = DOC_A) =>
    passage({ passageId: id, text, documentId });

  it("reads the section by default, the requested passage first", async () => {
    const s = setup({ section: [sec(P2, "before"), sec(P1, "asked"), sec(P3, "after")] });
    const out = unwrapTainted(await s.e.read_section.execute({ passageId: P1 }, toolCtx())) as {
      passages: { passageId: string }[];
    };
    expect(out.passages.map((p) => p.passageId)).toEqual([P1, P2, P3]);
    expect(s.calls[0]).toEqual({ op: "section", args: [vectorScope, P1, "section"] });
    expect(s.items.puts.map((p) => p.item.kind)).toEqual(["passages", "tool"]);
  });

  it("passes the neighbours span", async () => {
    const s = setup({ section: [sec(P1, "asked")] });
    await s.e.read_section.execute({ passageId: P1, span: "neighbours" }, toolCtx());
    expect(s.calls[0]?.args[2]).toBe("neighbours");
  });

  it("drops passages of documents outside the chat's scope, and is not_found when the asked one is outside", async () => {
    const mixed = setup({
      section: [sec(P1, "asked"), sec(P2, "other", DOC_B)],
      scope: { documentIds: [DOC_A] },
    });
    const out = unwrapTainted(await mixed.e.read_section.execute({ passageId: P1 }, toolCtx())) as {
      passages: unknown[];
    };
    expect(out.passages).toHaveLength(1);
    const outside = setup({ section: [sec(P1, "asked", DOC_B)], scope: { documentIds: [DOC_A] } });
    expect(
      unwrapTainted(await outside.e.read_section.execute({ passageId: P1 }, toolCtx())),
    ).toEqual({ error: "not_found" });
    const missing = setup({ section: [] });
    expect(
      unwrapTainted(await missing.e.read_section.execute({ passageId: P1 }, toolCtx())),
    ).toEqual({ error: "not_found" });
    expect(outside.items.puts).toEqual(missing.items.puts);
  });

  it("refuses a bad span", async () => {
    const s = setup({});
    await expect(
      s.e.read_section.execute({ passageId: P1, span: "all" }, toolCtx()),
    ).rejects.toBeInstanceOf(ChatToolInputError);
  });
});

describe("capSection", () => {
  const p = (n: number, chars: number) =>
    passage({ passageId: `0000000${n}-0000-4000-8000-00000000000${n}`, text: "x".repeat(chars) });

  it("keeps at most 8 passages", () => {
    const list = Array.from({ length: 12 }, (_, i) => p((i % 9) + 1, 10));
    expect(capSection(list, list[3]?.passageId ?? "")).toHaveLength(SECTION_MAX_PASSAGES);
  });

  it("puts the requested passage first and keeps the order of the rest", () => {
    const [a, b, c] = [p(1, 5), p(2, 5), p(3, 5)] as const;
    expect(capSection([a, b, c], c.passageId).map((x) => x.passageId)).toEqual([
      c.passageId,
      a.passageId,
      b.passageId,
    ]);
  });

  it("cuts the text at the character budget, truncating the passage that crosses it", () => {
    const list = [p(1, 7_000), p(2, 7_000), p(3, 7_000)];
    const out = capSection(list, list[0]?.passageId ?? "");
    expect(out.reduce((n, x) => n + x.text.length, 0)).toBeLessThanOrEqual(SECTION_MAX_CHARS + 1);
    expect(out).toHaveLength(2);
    expect(out[1]?.text.endsWith("…")).toBe(true);
  });

  it("skips a crossing passage when almost nothing of it would fit", () => {
    const list = [p(1, SECTION_MAX_CHARS - 50), p(2, 5_000)];
    expect(capSection(list, list[0]?.passageId ?? "")).toHaveLength(1);
  });

  it("truncates a first passage that alone is over the budget", () => {
    const out = capSection([p(1, SECTION_MAX_CHARS + 5_000)], p(1, 1).passageId);
    expect(out[0]?.text.length).toBe(SECTION_MAX_CHARS + 1);
  });
});
