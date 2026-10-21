import { describe, expect, it } from "vitest";
import { SURFACES } from "./catalog";
import { createViewPayloads } from "./payload";
import { EXPERIENCES } from "./views";

const NAMES = ["library", "library-empty", "detail", "sessions", "chat", "sources"] as const;
const views = createViewPayloads({ placeholderKey: "k".repeat(32), revisionKey: "r".repeat(32) });
const handlesOf = (name: (typeof NAMES)[number]) =>
  views
    .payload(name, "web")
    .inventory.handles.map((h) => `${h.handle}:${h.priority}`)
    .sort();

describe("the experiences", () => {
  it("are six, sealed and content-addressed, and the same bytes every boot", () => {
    expect(Object.keys(EXPERIENCES).sort()).toEqual([...NAMES].sort());
    const again = createViewPayloads({
      placeholderKey: "x".repeat(32),
      revisionKey: "y".repeat(32),
    });
    for (const n of NAMES) {
      expect(EXPERIENCES[n].versionHash).toMatch(/^sha256:/);
      expect(again.payload(n, "web").versionHash).toBe(views.payload(n, "web").versionHash);
    }
  });

  it.each(SURFACES)(
    "compile with no finding for the %s surface, and the inventory lists exactly the bound handles",
    (surface) => {
      for (const n of NAMES) {
        const p = views.payload(n, surface);
        expect(p.surface).toBe(surface);
        expect(p.blueprint).toMatchObject({ _tag: "Blueprint", irVersion: "2.5.0" });
        expect(p.inventory.versionHash).toBe(p.versionHash);
      }
      expect(handlesOf("library")).toEqual([
        "doc-ready:P0",
        "doc-total:P0",
        "documents:P0",
        "ingest:P0",
      ]);
      expect(handlesOf("library-empty")).toEqual([]);
      expect(handlesOf("detail")).toEqual([
        "doc-content:P1",
        "doc-facts:P1",
        "doc-minutes:P1",
        "doc-pages:P1",
        "doc-status:P0",
        "doc-summary:P0",
        "doc-words:P1",
      ]);
      expect(handlesOf("sessions")).toEqual(["chats:P0"]);
      expect(handlesOf("chat")).toEqual(["transcript:P2"]);
      expect(handlesOf("sources")).toEqual(["sources:P2"]);
    },
  );

  it("names, per handle, only the parameters a load may override", () => {
    const params = (n: (typeof NAMES)[number]) =>
      Object.fromEntries(
        views.payload(n, "web").inventory.handles.map((h) => [h.handle, h.params]),
      );
    expect(params("library").documents).toEqual(["status"]);
    expect(params("library")["doc-total"]).toEqual([]);
    expect(params("detail")["doc-summary"]).toEqual(["id"]);
    expect(params("detail")["doc-content"]).toEqual(["id", "passage", "upto"]);
    expect(params("sessions").chats).toEqual(["q"]);
  });

  it("the detail view is a tab set of three titled panels", () => {
    const blueprint = JSON.stringify(views.payload("detail", "web").blueprint);
    expect(blueprint).toContain('"role":"tabs"');
    for (const title of ["Summary", "Analysis", "Content"])
      expect(blueprint).toContain(`"${title}"`);
  });

  it("carry no provider detail and no data: the payload never names a tool, a pin or a script", () => {
    for (const n of NAMES) {
      const wire = JSON.stringify(views.payload(n, "web"));
      expect(wire).not.toMatch(
        /documents\.list|document\.get|document\.content|chats\.list|docmind:.*@1|scriptRef|toolName/,
      );
    }
  });

  it("hold the fixed texts of the empty state, and nothing a user owns", () => {
    expect(JSON.stringify(views.payload("library-empty", "web").blueprint)).toContain(
      "No documents yet",
    );
  });
});
