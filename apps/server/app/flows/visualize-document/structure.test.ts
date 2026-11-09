import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FieldKeyStoreError } from "../../crypto/fields";
import { DocumentGoneError } from "../ingest-document/errors";
import type { EntityCandidate, Mention } from "./cooccurrence";
import type { StructureFact } from "./facts";
import type { HeadingRow } from "./outline";
import type { VisualizeRef } from "./pgFacts";
import { type StructureReader, structureEffect } from "./structure";

const cid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const eid = (n: number) => `00000000-0000-4000-9000-${String(n).padStart(12, "0")}`;
const ref: VisualizeRef = {
  tenantId: randomUUID(),
  userId: randomUUID(),
  documentId: randomUUID(),
};
const HEADINGS: HeadingRow[] = [
  { chunkId: cid(1), sectionOrdinal: 1, headingPath: ["Zebra-A"] },
  { chunkId: cid(2), sectionOrdinal: 2, headingPath: ["Zebra-B"] },
  { chunkId: cid(3), sectionOrdinal: 3, headingPath: ["Zebra-B", "Zebra-C"] },
];
const CANDS: EntityCandidate[] = [1, 2, 3].map((n) => ({
  id: eid(n),
  kind: "person",
  name: `Person${n}`,
  passages: 2,
}));
const MENTIONS: Mention[] = CANDS.flatMap((c) =>
  [1, 2].map((o) => ({ entityId: c.id, chunkId: cid(o), ordinal: o })),
);

function setup(over: Partial<StructureReader> = {}) {
  const written: StructureFact[][] = [];
  const reader: StructureReader = {
    title: async () => "Zebra Report",
    headings: async () => HEADINGS,
    entities: async () => CANDS,
    mentions: async () => MENTIONS,
    ...over,
  };
  const deps = {
    guard: { begin: async () => {} },
    reader,
    facts: {
      replaceStructure: async (_r: VisualizeRef, facts: readonly StructureFact[]) => {
        written.push([...facts]);
        return facts.length;
      },
    },
    sleep: async () => {},
  };
  return { written, run: () => structureEffect(deps).execute(ref, {} as never) };
}

describe("visualize-structure step", () => {
  afterEach(() => vi.restoreAllMocks());

  it("derives the outline (ordinal 16) and the entity map (ordinal 17) and replaces the structure facts", async () => {
    const s = setup();
    expect(await s.run()).toEqual({ outcome: "done", count: 2 });
    expect(s.written).toHaveLength(1);
    expect(s.written[0]?.map((f) => [f.ordinal, f.kind])).toEqual([
      [16, "outline"],
      [17, "cooccurrence"],
    ]);
  });

  it("clears stale structure facts when nothing reaches its threshold", async () => {
    const s = setup({ headings: async () => [], entities: async () => [] });
    expect(await s.run()).toEqual({ outcome: "done", count: 0 });
    expect(s.written).toEqual([[]]);
  });

  it("skips only the outline when a passage or the title does not open", async () => {
    const s = setup({ headings: async () => null });
    expect(await s.run()).toEqual({ outcome: "done", count: 1 });
    expect(s.written[0]?.map((f) => f.kind)).toEqual(["cooccurrence"]);
    const t = setup({ title: async () => null });
    expect(await t.run()).toEqual({ outcome: "done", count: 1 });
  });

  it("skips only the map when an entity name does not open, and reads no mentions then", async () => {
    const mentions = vi.fn(async () => MENTIONS);
    const s = setup({ entities: async () => null, mentions });
    expect(await s.run()).toEqual({ outcome: "done", count: 1 });
    expect(s.written[0]?.map((f) => f.kind)).toEqual(["outline"]);
    expect(mentions).not.toHaveBeenCalled();
  });

  it("reports a vanished document as document_gone and writes nothing", async () => {
    const s = setup({
      title: async () => {
        throw new DocumentGoneError();
      },
    });
    expect(await s.run()).toEqual({ outcome: "document_gone" });
    expect(s.written).toEqual([]);
  });

  it("fails the step on a key-store outage, writing nothing", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const s = setup({
      headings: async () => {
        throw new FieldKeyStoreError();
      },
    });
    await expect(s.run()).rejects.toThrow(/^ingest step failed: visualize-structure$/);
    expect(s.written).toEqual([]);
  });

  it("logs the count only, never a heading or a name", async () => {
    const spies = (["info", "log", "warn", "error"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    const [info] = spies;
    await setup().run();
    // The step logs exactly this one line (so the assertion below is not vacuous)...
    expect(info?.mock.calls).toEqual([["visualize-structure facts", 2]]);
    // ...and nothing it logs, anywhere, carries a heading, the title or an entity name.
    const logged = JSON.stringify(spies.map((spy) => spy.mock.calls));
    for (const secret of ["Zebra", "Person1", "Person2", "Person3"])
      expect(logged, secret).not.toContain(secret);
  });
});
