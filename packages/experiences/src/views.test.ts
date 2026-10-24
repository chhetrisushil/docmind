import { CHAT_TYPE_VERSION, chatCatalogEntries } from "@loom-ui/core";
import { describe, expect, it } from "vitest";
import { SOURCES_VIEW } from "./a2ui";
import { DOCMIND_CATALOG, SURFACES } from "./catalog";
import { createViewPayloads } from "./payload";
import { EXPERIENCES } from "./views";

const NAMES = ["library", "library-empty", "detail", "sessions", "chat", "sources"] as const;
const views = createViewPayloads({ placeholderKey: "k".repeat(32), revisionKey: "r".repeat(32) });
const handlesOf = (name: (typeof NAMES)[number]) =>
  views
    .payload(name, "web")
    .inventory.handles.map((h) => `${h.handle}:${h.priority}`)
    .sort();

describe("the sources view", () => {
  it("marks the selected item and keys it by passage, and still builds into a sealed payload", () => {
    const item = SOURCES_VIEW.nodes.find((n) => n.id === "s-item") as Record<string, unknown>;
    expect(item.selected).toEqual({ path: "/selected" });
    expect(item.selectedKey).toEqual({ path: "/passageId" });
    expect(views.payload("sources", "web").inventory.handles.map((h) => h.handle)).toEqual([
      "sources",
    ]);
  });
});

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
      for (const surface of SURFACES)
        expect(JSON.stringify(again.payload(n, surface).blueprint)).toBe(
          JSON.stringify(views.payload(n, surface).blueprint),
        );
    }
  });

  it("refuse a placeholder or revision key under 16 bytes", () => {
    const ok = "k".repeat(16);
    expect(() => createViewPayloads({ placeholderKey: ok, revisionKey: ok })).not.toThrow();
    for (const bad of ["", "k".repeat(15), "é".repeat(7)]) {
      expect(() => createViewPayloads({ placeholderKey: bad, revisionKey: ok })).toThrow(
        /16 bytes/,
      );
      expect(() => createViewPayloads({ placeholderKey: ok, revisionKey: bad })).toThrow(
        /16 bytes/,
      );
    }
  });

  it("give every provider literal or empty arguments, and every overridable key exists in them", () => {
    for (const n of NAMES)
      for (const [handle, spec] of Object.entries(EXPERIENCES[n].providers)) {
        for (const step of spec.executionGraph) {
          const args = step.arguments as Record<string, unknown>;
          for (const [k, v] of Object.entries(args)) {
            const where = `${n}/${handle}/${k}`;
            expect(["string", "number", "boolean"], where).toContain(typeof v);
            if (typeof v === "string") expect(v, where).not.toMatch(/\{\{|\$\{|\$[A-Za-z_]|^@/);
          }
          for (const key of step.overridable ?? [])
            expect(Object.keys(args), `${n}/${handle}`).toContain(key);
        }
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
        "doc-source:P1",
        "doc-status:P0",
        "doc-summary:P0",
        "doc-type:P1",
        "doc-words:P1",
      ]);
      expect(handlesOf("sessions")).toEqual(["chats:P0"]);
      expect(handlesOf("chat")).toEqual(["chatScope:P2", "transcript:P2"]);
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
    expect(params("detail")["doc-source"]).toEqual(["id", "passage"]);
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

  describe("the chat's scope control", () => {
    type N = {
      id: string;
      type: string;
      typeVersion: string;
      props: Record<string, unknown>;
      binding?: { handle: string; priority: string };
      span: number;
      order: string;
    };
    const nodes = () => (EXPERIENCES.chat.root as unknown as { children: N[] }).children;
    const scope = () => nodes().find((n) => n.id === "scope") as N;

    it("is a multi-select bound to the chatScope handle, offering documents as data, never as props", () => {
      expect(scope().type).toBe("ScopeSelect");
      expect(scope().binding).toEqual({ handle: "chatScope", priority: "P2" });
      expect(scope().props).toEqual({
        label: "Search in",
        emptyLabel: "All documents",
        placeholder: "Add a document…",
        maxSelected: 100,
      });
      expect(Object.keys(EXPERIENCES.chat.providers).sort()).toEqual(["chatScope", "transcript"]);
      const entry = DOCMIND_CATALOG.entries.find((e) => e.name === "ScopeSelect");
      expect((entry?.surfaces?.web as { kind: string }).kind).toBe("MultiSelectInput");
    });
    it("puts the scope between the transcript and the composer, the composer after it", () => {
      expect(nodes().map((n) => n.id)).toEqual(["transcript", "scope", "composer"]);
      expect(nodes().map((n) => n.order)).toEqual(["a", "b", "c"]);
    });
    it("authors every chat-family node at the version loom-ui's catalogue carries", () => {
      for (const n of nodes()) expect(n.typeVersion, n.id).toBe(CHAT_TYPE_VERSION);
      const lib = (EXPERIENCES.library.root as unknown as { children: N[] }).children;
      expect(lib.find((n) => n.id === "filter")?.typeVersion).toBe(CHAT_TYPE_VERSION);
      expect(lib.find((n) => n.id === "total")?.typeVersion).toBe("1.0.0");
    });
    it("declares each chat-family entry exactly as loom-ui's own chat catalogue does (version, props, binding)", () => {
      const theirs = new Map(chatCatalogEntries().map((e) => [e.name, e]));
      let seen = 0;
      for (const e of DOCMIND_CATALOG.entries) {
        const kind = (e.surfaces?.web as { kind: string }).kind;
        const t = theirs.get(kind);
        if (!t) continue;
        seen++;
        expect(e.version, e.name).toBe(t.version);
        expect(e.binding, e.name).toBe(t.binding);
        expect(e.props, e.name).toEqual(t.props);
      }
      expect(seen).toBeGreaterThanOrEqual(5);
    });
  });
});
