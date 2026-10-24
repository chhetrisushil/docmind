import { FRAMEWORK_KINDS } from "@loom-ui/core";
import { describe, expect, it } from "vitest";
import { DOCMIND_CATALOG, ENTRY_KINDS, KINDS, SURFACES } from "./catalog";

describe("the DocMind semantic catalogue", () => {
  it("is surface-neutral: every entry resolves on every surface, to a loom-ui framework kind", () => {
    expect(SURFACES).toEqual(["web", "terminal"]);
    for (const [name, kind] of Object.entries(ENTRY_KINDS)) {
      expect(FRAMEWORK_KINDS, `${name} -> ${kind}`).toContain(kind);
      const entry = DOCMIND_CATALOG.entries.find((e) => e.name === name);
      expect(entry, name).toBeDefined();
      for (const surface of SURFACES)
        expect(
          (entry?.surfaces?.[surface] as { kind?: string } | undefined)?.kind,
          `${name} on ${surface}`,
        ).toBe(kind);
    }
  });
  it("lists exactly the seventeen entries, once each", () => {
    expect(DOCMIND_CATALOG.entries.map((e) => e.name).sort()).toEqual(
      Object.keys(ENTRY_KINDS).sort(),
    );
    expect(Object.keys(ENTRY_KINDS)).toHaveLength(17);
  });
  it("declares the same kind contracts loom-ui's renderers draw (props and binding)", () => {
    expect(KINDS.Table).toEqual({ kind: "Table", props: [], binding: "required" });
    expect(KINDS.A2UIView).toEqual({ kind: "A2UIView", props: ["view"], binding: "required" });
    expect(KINDS.Chat.props).toEqual(["emptyText", "editable"]);
    expect(KINDS.Note.binding).toBe("none");
  });
});
