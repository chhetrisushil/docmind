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
    const r = readersFor({ visualFacts: { list } } as never, identity);
    await expect(r.visualFacts({ id: "theirs" })).resolves.toBeNull();
    await expect(r.visualFacts({ id: "mine" })).resolves.toEqual([]);
    expect(list).toHaveBeenLastCalledWith({ tenantId: "t", userId: "u", documentId: "mine" });
  });
  it("rethrows any other failure", async () => {
    const { readersFor } = await import("./readers");
    const list = vi.fn(async () => {
      throw new Error("boom");
    });
    const r = readersFor(
      { visualFacts: { list } } as never,
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
