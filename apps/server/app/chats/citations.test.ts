import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DELETED_DOCUMENT, SNIPPET_MAX, citeReply } from "./citations";
import type { StoredPassage } from "./turnItems";

const passage = (over: Partial<StoredPassage> = {}): StoredPassage => ({
  passageId: randomUUID(),
  documentId: randomUUID(),
  locator: { kind: "page", page: 2 },
  headingPath: ["Terms"],
  snippet: "Payment is due within 30 days.",
  ...over,
});
const titlesOf = (...ps: StoredPassage[]) =>
  new Map(ps.map((p) => [p.documentId, `Doc ${p.documentId.slice(0, 4)}`]));

describe("citeReply", () => {
  it("keeps a marker for a retrieved passage and returns its citation with the document's current title", () => {
    const p = passage();
    const out = citeReply(`Due in 30 days [[${p.passageId}]].`, [p], titlesOf(p));
    expect(out.text).toBe(`Due in 30 days [[${p.passageId}]].`);
    expect(out.citations).toEqual([
      {
        passageId: p.passageId,
        documentId: p.documentId,
        docTitle: `Doc ${p.documentId.slice(0, 4)}`,
        locator: { kind: "page", page: 2 },
        snippet: "Payment is due within 30 days.",
      },
    ]);
  });

  it("strips a marker for a passage that was never retrieved, with the space before it, and cites nothing for it", () => {
    const real = passage();
    const invented = randomUUID();
    const out = citeReply(`A [[${real.passageId}]] and B [[${invented}]].`, [real], titlesOf(real));
    expect(out.text).toBe(`A [[${real.passageId}]] and B.`);
    expect(out.citations.map((c) => c.passageId)).toEqual([real.passageId]);
  });

  it("orders citations by first appearance and cites a passage once however often it is named", () => {
    const [a, b] = [passage(), passage()];
    const text = `x [[${b.passageId}]] y [[${a.passageId}]] z [[${b.passageId}]]`;
    expect(citeReply(text, [a, b], titlesOf(a, b)).citations.map((c) => c.passageId)).toEqual([
      b.passageId,
      a.passageId,
    ]);
  });

  it("names a document that was deleted since the answer", () => {
    const p = passage();
    expect(citeReply(`[[${p.passageId}]]`, [p], new Map()).citations[0]?.docTitle).toBe(
      DELETED_DOCUMENT,
    );
  });

  it("uses the first stored copy when a passage was retrieved twice in the turn", () => {
    const p = passage();
    const again = { ...p, snippet: "a later, different snippet" };
    expect(citeReply(`[[${p.passageId}]]`, [p, again], titlesOf(p)).citations[0]?.snippet).toBe(
      p.snippet,
    );
  });

  it("clips a long snippet to 280 characters without splitting a surrogate pair", () => {
    const p = passage({ snippet: `${"a".repeat(SNIPPET_MAX - 1)}😀 and more` });
    const clipped = citeReply(`[[${p.passageId}]]`, [p], titlesOf(p)).citations[0]?.snippet ?? "";
    expect(clipped.length).toBeLessThanOrEqual(SNIPPET_MAX);
    expect(clipped).toBe("a".repeat(SNIPPET_MAX - 1));
  });

  it("leaves text without markers, and markers that are not passage ids, exactly as they are", () => {
    const p = passage();
    expect(citeReply("No sources here.", [p], titlesOf(p))).toEqual({
      text: "No sources here.",
      citations: [],
    });
    const odd = "see [[not-an-id]] and [[ABCDEF01-2345-6789-ABCD-EF0123456789]]";
    expect(citeReply(odd, [p], titlesOf(p)).text).toBe(odd);
  });

  it("strips every marker when nothing was retrieved", () => {
    const id = randomUUID();
    expect(citeReply(`Claim [[${id}]].`, [], new Map())).toEqual({ text: "Claim.", citations: [] });
  });

  it("handles adversarial text (long runs of brackets, spaces and hex) in linear time", () => {
    const evil = `${" ".repeat(100000)}${"[[".repeat(50000)}${"a-".repeat(50000)}[[${"a".repeat(35)}`;
    expect(citeReply(evil, [], new Map())).toEqual({ text: evil, citations: [] });
  });
});
