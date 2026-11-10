import { describe, expect, it, vi } from "vitest";
import { STATUS_MESSAGES } from "../status/model";
import { FIXED_ERROR, fixedError } from "./readers";

describe("the error a document shows to the UI", () => {
  it("is null, or one of the status model's fixed sentences, or a fixed fallback: never other text", () => {
    expect(fixedError(null)).toBeNull();
    for (const message of Object.values(STATUS_MESSAGES)) expect(fixedError(message)).toBe(message);
    expect(fixedError("ENOENT /var/blobs/quarterly-report.pdf for alice@example.com")).toBe(
      FIXED_ERROR,
    );
    expect(fixedError("")).toBe(FIXED_ERROR);
  });
});

describe("the visualFacts reader", () => {
  it("returns null for a document the identity does not own, and the facts otherwise", async () => {
    const { DocumentGoneError } = await import("../flows/ingest-document/errors");
    const { readersFor } = await import("./readers");
    const identity = { userId: "u", tenantId: "t" } as never;
    const list = vi.fn(async (ref: { documentId: string }) => {
      if (ref.documentId === "mine") return [];
      throw new DocumentGoneError();
    });
    const r = readersFor({ visualFacts: { listAll: list } } as never, identity);
    await expect(r.visualFacts({ id: "theirs" })).resolves.toBeNull();
    await expect(r.visualFacts({ id: "mine" })).resolves.toEqual([]);
    expect(list).toHaveBeenLastCalledWith({ tenantId: "t", userId: "u", documentId: "mine" });
  });
  it("a chat turn's read (extractedOnly) lists the extracted facts only and never opens the structure facts", async () => {
    const { readersFor } = await import("./readers");
    const list = vi.fn(async () => []);
    const listAll = vi.fn(async () => []);
    const r = readersFor(
      { visualFacts: { list, listAll } } as never,
      { userId: "u", tenantId: "t" } as never,
    );
    await r.visualFacts({ id: "d", extractedOnly: true });
    expect(list).toHaveBeenCalledWith({ tenantId: "t", userId: "u", documentId: "d" });
    expect(listAll).not.toHaveBeenCalled();
    await r.visualFacts({ id: "d" });
    expect(listAll).toHaveBeenCalledTimes(1);
  });
  it("rethrows any other failure", async () => {
    const { readersFor } = await import("./readers");
    const list = vi.fn(async () => {
      throw new Error("boom");
    });
    const r = readersFor(
      { visualFacts: { listAll: list } } as never,
      { userId: "u", tenantId: "t" } as never,
    );
    await expect(r.visualFacts({ id: "x" })).rejects.toThrow("boom");
  });
});

describe("the source reader", () => {
  it("delegates to readSource, turning an empty passage into undefined", async () => {
    vi.resetModules();
    const readSource = vi.fn(async () => ({ applicable: false as const }));
    vi.doMock("../documents/source", () => ({ readSource }));
    const { readersFor } = await import("./readers");
    const deps = { pool: {}, blobs: {}, registry: {} } as never;
    const identity = { userId: "u", tenantId: "t" } as never;
    const r = readersFor(deps, identity);
    await expect(r.source({ id: "d", passage: "" })).resolves.toEqual({ applicable: false });
    expect(readSource).toHaveBeenLastCalledWith(deps, identity, "d", undefined);
    await r.source({ id: "d", passage: "p" });
    expect(readSource).toHaveBeenLastCalledWith(deps, identity, "d", "p");
    vi.doUnmock("../documents/source");
  });
});

describe("the turnFacts reader", () => {
  const identity = { userId: "u", tenantId: "t" } as never;
  const fact = { kind: "figure", label: "Revenue", value: 4242, chunkIds: [], ordinal: 0 };
  it("reads the caller's own turn facts, scoped by tenant and user, and answers null when the turn has none", async () => {
    const { readersFor } = await import("./readers");
    const list = vi.fn(async (ref: { ord: number }) => (ref.ord === 4 ? [fact] : []));
    const r = readersFor({ turnFacts: { list } } as never, identity);
    await expect(r.turnFacts({ chatId: "c", ord: 4 })).resolves.toEqual([fact]);
    await expect(r.turnFacts({ chatId: "c", ord: 5 })).resolves.toBeNull();
    expect(list).toHaveBeenLastCalledWith({ tenantId: "t", userId: "u", chatId: "c", ord: 5 });
  });
  it("rethrows a failure (a destroyed key is not 'no facts')", async () => {
    const { readersFor } = await import("./readers");
    const r = readersFor(
      {
        turnFacts: {
          list: vi.fn(async () => {
            throw new Error("boom");
          }),
        },
      } as never,
      identity,
    );
    await expect(r.turnFacts({ chatId: "c", ord: 4 })).rejects.toThrow("boom");
  });
});

describe("citations on facts", () => {
  const D = "0b4f7d52-6c53-4c6e-9d49-2b0e7a3f9a10";
  const C1 = "7f6d1b8e-3b0a-4a56-8f2f-000000000001";
  const C2 = "7f6d1b8e-3b0a-4a56-8f2f-000000000002";
  const C3 = "7f6d1b8e-3b0a-4a56-8f2f-000000000003";
  const fact = (ordinal: number, chunkIds: string[]) => ({
    kind: "figure" as const,
    label: "Revenue",
    value: 1,
    chunkIds,
    ordinal,
  });
  const identity = { userId: "u", tenantId: "t" } as never;
  it("attaches, in the fact's own order and without repeats, the resolved chunks; an unresolved chunk (a deleted document) is dropped", async () => {
    vi.resetModules();
    const resolve = vi.fn(async () => {
      return new Map([
        [C1, { documentId: D, label: "Report, Page 1" }],
        [C3, { documentId: D, label: "Report, Page 3" }],
      ]);
    });
    vi.doMock("./factCites", () => ({ resolveCites: resolve }));
    const { readersFor } = await import("./readers");
    const list = vi.fn(async () => [fact(0, [C3, C1, C2, C1]), fact(1, [C2])]);
    const r = readersFor(
      { visualFacts: { listAll: list }, pool: {}, fields: {} } as never,
      identity,
    );
    const out = (await r.visualFacts({ id: D })) as { cites?: unknown[] }[];
    expect(out[0]?.cites).toEqual([
      { documentId: D, passageId: C3, label: "Report, Page 3" },
      { documentId: D, passageId: C1, label: "Report, Page 1" },
    ]);
    expect(out[1]?.cites).toEqual([]);
    expect(resolve).toHaveBeenCalledTimes(1); // one lookup for every fact
    vi.doUnmock("./factCites");
  });
  it("resolves at most 16 distinct chunk ids per fact (a widget shows 16 refs), keeping the first ones", async () => {
    vi.resetModules();
    const resolve = vi.fn(async (_d: unknown, _w: unknown, ids: readonly string[]) => {
      return new Map(ids.map((i) => [i, { documentId: D, label: `P ${i}` }]));
    });
    vi.doMock("./factCites", () => ({ resolveCites: resolve }));
    const { readersFor } = await import("./readers");
    const many = Array.from(
      { length: 120 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    );
    const list = vi.fn(async () => [fact(16, many)]);
    const r = readersFor(
      { visualFacts: { listAll: list }, pool: {}, fields: {} } as never,
      identity,
    );
    const out = (await r.visualFacts({ id: D })) as { cites?: { passageId: string }[] }[];
    expect(resolve.mock.calls[0]?.[2]).toEqual(many.slice(0, 16));
    expect(out[0]?.cites?.map((c) => c.passageId)).toEqual(many.slice(0, 16));
    vi.doUnmock("./factCites");
  });
  it("does the same for a turn's facts", async () => {
    vi.resetModules();
    vi.doMock("./factCites", () => ({
      resolveCites: vi.fn(async () => new Map([[C1, { documentId: D, label: "Report, Page 1" }]])),
    }));
    const { readersFor } = await import("./readers");
    const list = vi.fn(async () => [fact(0, [C1])]);
    const r = readersFor({ turnFacts: { list }, pool: {}, fields: {} } as never, identity);
    const out = (await r.turnFacts({ chatId: D, ord: 1 })) as { cites?: unknown[] }[];
    expect(out[0]?.cites).toEqual([{ documentId: D, passageId: C1, label: "Report, Page 1" }]);
    vi.doUnmock("./factCites");
  });
});

describe("the connections reader", () => {
  it("reads the connections of the caller's document with the caller's identity", async () => {
    vi.resetModules();
    const readConnections = vi.fn(async () => null);
    vi.doMock("./connections", () => ({ readConnections }));
    const { readersFor } = await import("./readers");
    const deps = { pool: {}, fields: {} } as never;
    const identity = { userId: "u", tenantId: "t" } as never;
    const r = readersFor(deps, identity);
    await expect(r.connections({ documentId: "d" })).resolves.toBeNull();
    expect(readConnections).toHaveBeenLastCalledWith(deps, identity, "d");
    vi.doUnmock("./connections");
  });
});
