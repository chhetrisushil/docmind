import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/http";
import {
  PICKER_CAP,
  type ScopeDoc,
  listRecent,
  lookUp,
  pickerValue,
  scopeFor,
} from "./scopePicker";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const C = "00000000-0000-4000-8000-00000000000c";
const D = "00000000-0000-4000-8000-00000000000d";
const doc = (id: string, title: string, status: ScopeDoc["status"] = "ready"): ScopeDoc => ({
  id,
  title,
  status,
});

describe("pickerValue", () => {
  const listed = [doc(A, "Q3 report"), doc(B, "Contract v2"), doc(C, "Invoice", "embedding")];
  it("offers the ready documents; a chat searching everything has no chips", () => {
    expect(pickerValue(listed, "all", new Map(), false)).toEqual({
      options: [
        { value: A, label: "Q3 report" },
        { value: B, label: "Contract v2" },
      ],
      selected: [],
    });
  });
  it("puts the chat's documents first, in scope order, with a hint for one not ready", () => {
    expect(pickerValue(listed, { documentIds: [C, B] }, new Map(), false)).toEqual({
      options: [
        { value: C, label: "Invoice", hint: "processing" },
        { value: B, label: "Contract v2" },
        { value: A, label: "Q3 report" },
      ],
      selected: [C, B],
    });
  });
  it("labels a scoped document from its own lookup, or as removed when it is gone", () => {
    const found = new Map([[D, doc(D, "Old memo", "failed")]]);
    const gone = "00000000-0000-4000-8000-0000000000ee";
    const v = pickerValue(listed, { documentIds: [D, gone] }, found, false);
    expect(v.options.slice(0, 2)).toEqual([
      { value: D, label: "Old memo", hint: "failed" },
      { value: gone, label: "Removed document" },
    ]);
  });
  it("says when the list is capped; an untitled document falls back to a fixed label", () => {
    expect(pickerValue([doc(A, "")], "all", new Map(), true)).toEqual({
      options: [{ value: A, label: "Untitled document" }],
      selected: [],
      note: `Showing the ${PICKER_CAP} most recent documents`,
    });
  });
});

describe("scopeFor", () => {
  it("drops removed documents, and an empty set searches everything", () => {
    expect(scopeFor([A, B], new Set([B]))).toEqual({ documentIds: [A] });
    expect(scopeFor([B], new Set([B]))).toBe("all");
    expect(scopeFor([], new Set())).toBe("all");
  });
  it("keeps a document that could not be looked up (only a confirmed removal drops one)", () => {
    expect(scopeFor([C], new Set())).toEqual({ documentIds: [C] });
  });
});

describe("listRecent", () => {
  it("pages until the cap and says whether more exist", async () => {
    const page = (n: number, next: string | null) => ({
      items: Array.from({ length: n }, (_, i) => ({ ...doc(`${i}`, `T${i}`) })),
      nextCursor: next,
    });
    const api = {
      listDocuments: vi
        .fn()
        .mockResolvedValueOnce(page(100, "c1"))
        .mockResolvedValueOnce(page(100, "c2")),
    };
    const out = await listRecent(api as never);
    expect(api.listDocuments).toHaveBeenCalledTimes(2);
    expect(api.listDocuments).toHaveBeenLastCalledWith("c1");
    expect(out.docs).toHaveLength(200);
    expect(out.capped).toBe(true);
    const one = { listDocuments: vi.fn().mockResolvedValueOnce(page(3, null)) };
    expect((await listRecent(one as never)).capped).toBe(false);
  });
});

describe("lookUp", () => {
  it("finds each id; a 404 is removed; any other failure is neither (never dropped from a scope on a network error)", async () => {
    const api = {
      getDocument: vi.fn(async (id: string) => {
        if (id === A) return doc(A, "Q3 report");
        if (id === B) throw new ApiError(404, "not_found");
        throw new ApiError(500, "boom");
      }),
    };
    const out = await lookUp(api as never, [A, B, C]);
    expect([...out.found.keys()]).toEqual([A]);
    expect([...out.removed]).toEqual([B]);
  });
});
