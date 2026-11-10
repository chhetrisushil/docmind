import { describe, expect, it } from "vitest";
import {
  ListTagsResponse,
  SetDocumentTagsRequest,
  TagIdList,
  TagName,
  TagNameRequest,
  cleanTagName,
  clipTagName,
  normaliseTagName,
} from "./tags";

// Ids with hex letters (a00000000001), so the case tests below can fail: an upper-cased digit-only id is unchanged.
const id = (n: number) => `00000000-0000-4000-8000-${(0xa00000000000 + n).toString(16)}`;

describe("cleanTagName", () => {
  it("trims, keeps inner spacing and case, and counts characters not code units", () => {
    expect(cleanTagName("  Q3 report ")).toBe("Q3 report");
    expect(cleanTagName("a   b")).toBe("a   b");
    expect(cleanTagName("\u{1F600}".repeat(40))).toBe("\u{1F600}".repeat(40));
    expect(cleanTagName("x".repeat(40))).toBe("x".repeat(40));
  });
  it.each([
    "",
    "   ",
    "x".repeat(41),
    "\u{1F600}".repeat(41),
    "a\nb",
    "a\tb",
    "a\u0000b",
    "a\uD800b",
    "a\uDBFFb",
    "\u200B",
    "a\u200Db",
    "a\u2060b",
    "\uFEFFa",
    "abc\u202Edef",
    "a\u2066b",
    "a\u2028b",
    "a\u2029b",
  ])("refuses %j", (raw) => {
    expect(cleanTagName(raw)).toBeNull();
  });
});

describe("normaliseTagName", () => {
  it("is NFKC, trimmed, one inner space, case-folded", () => {
    expect(normaliseTagName("ＡＢＣ")).toBe("abc");
    expect(normaliseTagName("  Q3   Report ")).toBe("q3 report");
    expect(normaliseTagName("Straße")).toBe(normaliseTagName("STRASSE"));
    expect(normaliseTagName("é")).toBe(normaliseTagName("é"));
    expect(normaliseTagName("A B")).toBe("a b");
  });
  it("folds fully: capital sharp S, ß and ss meet, and the fold is idempotent", () => {
    const ss = normaliseTagName("STRASSE");
    expect(normaliseTagName("STRA\u1E9EE")).toBe(ss);
    expect(normaliseTagName("Straße")).toBe(ss);
    expect(normaliseTagName(ss as string)).toBe(ss);
  });
  it("is null for lone surrogates, invisible, bidi and separator characters", () => {
    for (const bad of ["a\uD800b", "\u200B", "a\u202Eb", "a\u2028b", "\uFEFFa"])
      expect(normaliseTagName(bad)).toBeNull();
  });
  it("is null for a name that is not a valid tag name", () => {
    expect(normaliseTagName("")).toBeNull();
    expect(normaliseTagName("x".repeat(41))).toBeNull();
  });
});

describe("tag schemas", () => {
  it("TagName trims and refuses an invalid name without echoing it", () => {
    expect(TagName.parse(" Finance ")).toBe("Finance");
    const bad = TagName.safeParse("a\nb");
    expect(bad.success).toBe(false);
    expect(JSON.stringify(bad)).not.toContain("a\\nb");
    expect(TagName.safeParse("x".repeat(500)).success).toBe(false);
  });
  it("TagNameRequest is strict", () => {
    expect(TagNameRequest.safeParse({ name: "a", extra: 1 }).success).toBe(false);
    expect(TagNameRequest.parse({ name: " a " })).toEqual({ name: "a" });
  });
  it("SetDocumentTagsRequest lowercases ids and holds at most 20", () => {
    const up = id(1).toUpperCase();
    expect(up).not.toBe(id(1)); // the input really differs in case
    expect(SetDocumentTagsRequest.parse({ tagIds: [up] }).tagIds).toEqual([id(1)]);
    const many = Array.from({ length: 21 }, (_, i) => id(i + 1));
    expect(SetDocumentTagsRequest.safeParse({ tagIds: many }).success).toBe(false);
  });
  it("TagIdList: empty is none, duplicates collapse, more than 10 or a bad id is refused", () => {
    expect(TagIdList.parse("")).toEqual([]);
    expect(id(1).toUpperCase()).not.toBe(id(1));
    expect(TagIdList.parse(`${id(1)},${id(2)},${id(1).toUpperCase()}`)).toEqual([id(1), id(2)]);
    const eleven = Array.from({ length: 11 }, (_, i) => id(i + 1)).join(",");
    expect(TagIdList.safeParse(eleven).success).toBe(false);
    expect(TagIdList.safeParse(`${id(1)},nope`).success).toBe(false);
  });
  it("duplicates collapse before the caps", () => {
    const same = Array.from({ length: 21 }, () => id(1));
    expect(SetDocumentTagsRequest.parse({ tagIds: same }).tagIds).toEqual([id(1)]);
    expect(TagIdList.parse(Array.from({ length: 30 }, () => id(1)).join(","))).toEqual([id(1)]);
    const distinct = Array.from({ length: 21 }, (_, i) => id(i + 1));
    expect(SetDocumentTagsRequest.safeParse({ tagIds: distinct }).success).toBe(false);
  });
  it("ListTagsResponse needs a document count per tag", () => {
    expect(ListTagsResponse.safeParse({ tags: [{ id: id(1), name: "a" }] }).success).toBe(false);
    expect(
      ListTagsResponse.safeParse({ tags: [{ id: id(1), name: "a", documents: 0 }] }).success,
    ).toBe(true);
  });
});

describe("clipTagName", () => {
  it("keeps 40 code points and never splits a surrogate pair", () => {
    expect([...clipTagName("\u{1F600}".repeat(45))]).toHaveLength(40);
    expect(clipTagName("abc")).toBe("abc");
  });
});
