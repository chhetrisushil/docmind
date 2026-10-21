import { compile } from "@loom-ui/core";
import { describe, expect, it } from "vitest";
import { DOCMIND_CATALOG, SURFACES } from "./catalog";
import { build, panel, tabs, widget } from "./compose";

const notice = (id: string) => widget({ id, type: "Notice", props: { text: "Hello" } });
const make = () =>
  build({
    id: "docmind.test",
    objective: "Test",
    children: [
      notice("a"),
      tabs("t", [panel("p1", "One", [notice("b")]), panel("p2", "Two", [notice("c")])]),
    ],
  });

describe("compose", () => {
  it("seals: a content address that is stable between builds and changes with the content", () => {
    expect(make().versionHash).toMatch(/^sha256:/);
    expect(make().versionHash).toBe(make().versionHash);
    expect(
      build({ id: "docmind.test", objective: "Test", children: [notice("a")] }).versionHash,
    ).not.toBe(make().versionHash);
  });
  it("gives every node an ordering key, level by level", () => {
    const root = make().root as {
      children: { id: string; order: string; children?: { order: string }[] }[];
    };
    expect(root.children.map((c) => c.order)).toEqual(["a", "b"]);
    expect(root.children[1]?.children?.map((c) => c.order)).toEqual(["a", "b"]);
  });
  it("compiles with no finding on every surface (a titled tabs container, widgets with text props)", () => {
    for (const surface of SURFACES) {
      const r = compile(make(), {
        surface,
        catalog: DOCMIND_CATALOG,
        hydrationProjectionId: "loom-ui.hydration",
        hydrationProjectionVersion: "1.1.0",
        viewer: {},
        placeholderKey: "k".repeat(32),
      });
      expect(r.findings, surface).toEqual([]);
      expect(r.ok).toBe(true);
    }
  });
  it("refuses more than 26 siblings (the ordering keys are single letters)", () => {
    expect(() =>
      build({
        id: "x",
        objective: "x",
        children: Array.from({ length: 27 }, (_, i) => notice(`n${i}`)),
      }),
    ).toThrow(/at most 26/);
  });
});
