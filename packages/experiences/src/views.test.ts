import {
  CHAT_TYPE_VERSION,
  type ContainerNode,
  type Experience,
  type ExperienceNode,
  type Operation,
  type ProviderSpec,
  type SemanticNode,
  chatCatalogEntries,
  compile,
  genesis,
  replay,
} from "@loom-ui/core";
import { HYDRATION_PROJECTION_ID, HYDRATION_PROJECTION_VERSION } from "@loom-ui/hydration";
import { describe, expect, it } from "vitest";
import { SOURCES_VIEW } from "./a2ui";
import { DOCMIND_CATALOG, SURFACES } from "./catalog";
import { createViewPayloads } from "./payload";
import { provider } from "./providers";
import { EXPERIENCES, detailWithVisuals, documentsOfVisuals, turnWithVisuals } from "./views";
import { factProvider, mergedCatalog } from "./visuals";

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

describe("detailWithVisuals", () => {
  const DOC = "doc-1";
  const KEY = "k".repeat(32);
  const kf = (
    id: string,
    type: string,
    handle: string,
    extra?: Partial<SemanticNode>,
  ): SemanticNode =>
    ({
      id,
      order: id,
      kind: "semantic",
      type,
      typeVersion: "1.0.0",
      span: 6,
      props: {},
      binding: { handle, priority: "P0" },
      ...extra,
    }) as SemanticNode;
  const visualsOf = (nodes: SemanticNode[], wrap = false): Experience => {
    const g = genesis({
      experienceId: "docmind.visuals",
      intent: { objective: "Visuals", source: "user" },
      meta: { author: "planner", createdAt: "2026-11-08T00:00:00Z", sourceKind: "code" },
    });
    const ops: Operation[] = [];
    const parent = wrap ? "sec" : g.root.id;
    if (wrap)
      ops.push({
        type: "insertNode",
        parentId: g.root.id,
        node: {
          id: "sec",
          order: "a",
          kind: "container",
          direction: "grid",
          span: 12,
          children: [],
        },
      });
    const handles = [...new Set(nodes.map((n) => n.binding?.handle as string))];
    for (const h of handles)
      ops.push({
        type: "remapProvider",
        handle: h,
        spec: { ...factProvider(0, "planner-guess", "KeyFigure"), handle: h },
      });
    nodes.forEach((n, i) =>
      ops.push({
        type: "insertNode",
        parentId: parent,
        node: { ...n, order: String.fromCharCode(0x61 + i), binding: undefined },
      }),
    );
    for (const n of nodes)
      ops.push({
        type: "bindProvider",
        nodeId: n.id,
        handle: n.binding?.handle as string,
        priority: n.binding?.priority,
      });
    const r = replay(g, ops);
    if (!r.ok) throw new Error(JSON.stringify(r));
    return r.value;
  };
  const sampleVisuals = () => visualsOf([kf("kf", "KeyFigure", "fact-0")]);
  const find = (n: ExperienceNode, id: string): ExperienceNode | undefined =>
    n.id === id
      ? n
      : n.kind === "container"
        ? n.children.map((c) => find(c, id)).find((x) => x)
        : undefined;
  const node = (e: Experience, id: string) => find(e.root, id) as ContainerNode;

  it("without visuals it is the static detail", () => {
    expect(detailWithVisuals(null, DOC).versionHash).toBe(EXPERIENCES.detail.versionHash);
  });

  it("adds a Visuals panel after Content with prefixed ids and a generated provider per fact", () => {
    const exp = detailWithVisuals(sampleVisuals(), DOC);
    expect(node(exp, "tabs").children.map((c) => c.id)).toEqual([
      "summary",
      "analysis",
      "content",
      "visuals",
    ]);
    expect(node(exp, "visuals").children.map((c) => c.id)).toEqual(["v-kf"]);
    expect(exp.providers["fact-0"]).toEqual(factProvider(0, DOC, "KeyFigure"));
    expect(exp.providers["fact-0"]?.executionGraph[0]?.arguments).toEqual({ id: DOC });
    expect(Object.keys(exp.providers)).toContain("doc-status");
  });

  it("copies nested containers with prefixed ids", () => {
    const exp = detailWithVisuals(visualsOf([kf("kf", "KeyFigure", "fact-0")], true), DOC);
    const sec = node(exp, "visuals").children[0] as ContainerNode;
    expect(sec.id).toBe("v-sec");
    expect(sec.children.map((c) => c.id)).toEqual(["v-kf"]);
  });

  it("gives a second entry on the same fact its own fact-n-b handle and provider", () => {
    const exp = detailWithVisuals(
      visualsOf([kf("a", "KeyFigure", "fact-1"), kf("b", "FigureChart", "fact-1")]),
      DOC,
    );
    const [a, b] = node(exp, "visuals").children as unknown as SemanticNode[];
    expect(a?.binding?.handle).toBe("fact-1");
    expect(b?.binding?.handle).toBe("fact-1-b");
    expect(exp.providers["fact-1"]).toEqual(factProvider(1, DOC, "KeyFigure"));
    expect(exp.providers["fact-1-b"]).toEqual({
      ...factProvider(1, DOC, "FigureChart"),
      handle: "fact-1-b",
    });
    expect(exp.providers["fact-1-b"]?.reshaping).toEqual({
      engine: "Named",
      scriptRef: "visual-bar-1",
    });
  });

  it("binds a planner P2 node at P1, and leaves P0 and P1 as they are", () => {
    const at = (id: string, priority: string, handle: string) =>
      kf(id, "KeyFigure", handle, { binding: { handle, priority } } as never);
    const exp = detailWithVisuals(
      visualsOf([at("a", "P0", "fact-0"), at("b", "P1", "fact-1"), at("c", "P2", "fact-2")]),
      DOC,
    );
    const kids = node(exp, "visuals").children as unknown as SemanticNode[];
    expect(kids.map((c) => c.binding?.priority)).toEqual(["P0", "P1", "P1"]);
  });

  it("drops a node with an unknown handle and keeps its sibling", () => {
    const exp = detailWithVisuals(
      visualsOf([kf("bad", "KeyFigure", "weird"), kf("ok", "KeyFigure", "fact-0")]),
      DOC,
    );
    expect(node(exp, "visuals").children.map((c) => c.id)).toEqual(["v-ok"]);
    expect(exp.providers.weird).toBeUndefined();
  });

  it("drops a node whose type is not a visuals entry", () => {
    const exp = detailWithVisuals(
      visualsOf([kf("bad", "DocumentKpi", "fact-0"), kf("ok", "KeyFigure", "fact-1")]),
      DOC,
    );
    expect(node(exp, "visuals").children.map((c) => c.id)).toEqual(["v-ok"]);
    expect(exp.providers["fact-0"]).toBeUndefined();
  });

  it("suffixes a third distinct entry on one fact with -c", () => {
    const exp = detailWithVisuals(
      visualsOf([
        kf("a", "KeyFigure", "fact-0"),
        kf("b", "FigureChart", "fact-0"),
        kf("c", "FigureTrend", "fact-0"),
        kf("d", "KeyFigure", "fact-0"),
      ]),
      DOC,
    );
    const handles = (node(exp, "visuals").children as unknown as SemanticNode[]).map(
      (c) => c.binding?.handle,
    );
    expect(handles).toEqual(["fact-0", "fact-0-b", "fact-0-c", "fact-0"]);
    expect(Object.keys(exp.providers).filter((h) => h.startsWith("fact-"))).toEqual([
      "fact-0",
      "fact-0-b",
      "fact-0-c",
    ]);
  });

  it("returns the static detail when every node is dropped", () => {
    const exp = detailWithVisuals(visualsOf([kf("bad", "KeyFigure", "fact-99")], true), DOC);
    expect(exp.versionHash).toBe(EXPERIENCES.detail.versionHash);
  });

  it("compiles for web and terminal with no findings", () => {
    for (const surface of ["web", "terminal"] as const) {
      const r = compile(
        detailWithVisuals(
          visualsOf([kf("a", "KeyFigure", "fact-1"), kf("b", "FigureChart", "fact-1")]),
          DOC,
        ),
        {
          surface,
          catalog: mergedCatalog(),
          hydrationProjectionId: HYDRATION_PROJECTION_ID,
          hydrationProjectionVersion: HYDRATION_PROJECTION_VERSION,
          viewer: {},
          placeholderKey: KEY,
        },
      );
      expect(r.findings).toEqual([]);
    }
  });
});

describe("turnWithVisuals", () => {
  const CHAT = "00000000-0000-4000-8000-0000000000c1";
  const A = "00000000-0000-4000-8000-00000000000a";
  const B = "00000000-0000-4000-8000-00000000000b";
  const node = (id: string, type: string, handle: string, order = "a"): SemanticNode =>
    ({
      id,
      order,
      kind: "semantic",
      type,
      typeVersion: "1.0.0",
      span: 6,
      props: {},
      binding: { handle, priority: "P0" },
    }) as SemanticNode;
  /** What the planner commits: a provider per capability whose single step carries that capability's pin. */
  const planned = (handle: string, tool: "visual.facts" | "turn.facts", pin: string) => {
    const spec = provider(handle, { target: tool, args: {}, reshaper: "x" });
    return {
      ...spec,
      executionGraph: [{ ...spec.executionGraph[0], toolName: tool, toolSchemaHash: pin }],
    } as ProviderSpec;
  };
  const experience = (nodes: SemanticNode[], specs: ProviderSpec[]): Experience => {
    const g = genesis({
      experienceId: "docmind.turnvisuals",
      intent: { objective: "Visuals", source: "user" },
      meta: { author: "planner", createdAt: "2026-11-08T00:00:00Z", sourceKind: "code" },
    });
    const ops: Operation[] = [
      ...specs.map((s) => ({ type: "remapProvider", handle: s.handle, spec: s }) as Operation),
      ...nodes.map(
        (n, i) =>
          ({
            type: "insertNode",
            parentId: g.root.id,
            node: { ...n, order: String.fromCharCode(0x61 + i) },
          }) as Operation,
      ),
    ];
    const r = replay(g, ops);
    if (!r.ok) throw new Error("fixture does not replay");
    return r.value;
  };
  const live = new Set([A, B]);

  it("points each node at the document and ordinal its pin names, and a turn fact at the turn's own read", () => {
    const e = experience(
      [
        node("n1", "KeyFigure", "p-a"),
        node("n2", "FactTable", "p-b"),
        node("n3", "FigureChart", "p-c"),
      ],
      [
        planned("p-a", "visual.facts", `docmind:visual.facts@1#${A}/fact-0`),
        planned("p-b", "visual.facts", `docmind:visual.facts@1#${B}/fact-2`),
        planned("p-c", "turn.facts", "docmind:turn.facts@1#fact-1"),
      ],
    );
    const out = turnWithVisuals(e, { chatId: CHAT, ord: 6 }, live) as Experience;
    const steps = Object.values(out.providers).map((p) => [
      p.executionGraph[0]?.toolName,
      p.executionGraph[0]?.arguments,
      (p.reshaping as { scriptRef: string }).scriptRef,
    ]);
    expect(steps).toEqual([
      ["visual.facts", { id: A }, "visual-kpi-0"],
      ["visual.facts", { id: B }, "visual-table-2"],
      ["turn.facts", { chatId: CHAT, ord: 6 }, "visual-bar-1"],
    ]);
  });

  it("lists the distinct documents the planner's providers name, and none for turn or detail pins", () => {
    const e = experience(
      [
        node("n1", "KeyFigure", "p-a"),
        node("n2", "KeyFigure", "p-b"),
        node("n3", "KeyFigure", "p-c"),
        node("n4", "KeyFigure", "p-d"),
        node("n5", "KeyFigure", "p-e"),
      ],
      [
        planned("p-a", "visual.facts", `docmind:visual.facts@1#${A}/fact-0`),
        planned("p-b", "visual.facts", `docmind:visual.facts@1#${A}/fact-1`),
        planned("p-c", "visual.facts", `docmind:visual.facts@1#${B}/fact-0`),
        planned("p-d", "turn.facts", "docmind:turn.facts@1#fact-0"),
        planned("p-e", "visual.facts", "docmind:visual.facts@1#fact-0"), // a detail pin names no document
      ],
    );
    expect(documentsOfVisuals(e)).toEqual([A, B]);
  });

  it("drops a node whose document is no longer the user's, and everything when nothing is left", () => {
    const e = experience(
      [node("n1", "KeyFigure", "p-a"), node("n2", "KeyFigure", "p-b")],
      [
        planned("p-a", "visual.facts", `docmind:visual.facts@1#${A}/fact-0`),
        planned("p-b", "visual.facts", `docmind:visual.facts@1#${B}/fact-0`),
      ],
    );
    const some = turnWithVisuals(e, { chatId: CHAT, ord: 6 }, new Set([A])) as Experience;
    expect(Object.keys(some.providers)).toHaveLength(1);
    expect(turnWithVisuals(e, { chatId: CHAT, ord: 6 }, new Set())).toBeNull();
    expect(turnWithVisuals(null, { chatId: CHAT, ord: 6 }, live)).toBeNull();
  });

  it("ignores a detail-page pin, a malformed pin and a provider the planner never declared", () => {
    const e = experience(
      [
        node("n1", "KeyFigure", "p-a"),
        node("n2", "KeyFigure", "p-b"),
        node("n3", "KeyFigure", "p-missing"),
      ],
      [
        planned("p-a", "visual.facts", "docmind:visual.facts@1#fact-0"),
        planned("p-b", "visual.facts", "docmind:visual.facts@1#garbage"),
      ],
    );
    expect(turnWithVisuals(e, { chatId: CHAT, ord: 6 }, live)).toBeNull();
  });

  it("binds a planner P2 turn node at P1, so the web requests every handle", () => {
    const n = node("n1", "KeyFigure", "p-a");
    const e = experience(
      [{ ...n, binding: { handle: "p-a", priority: "P2" } } as SemanticNode],
      [planned("p-a", "turn.facts", "docmind:turn.facts@1#fact-0")],
    );
    const out = turnWithVisuals(e, { chatId: CHAT, ord: 6 }, live) as Experience;
    const [c] = out.root.kind === "container" ? (out.root.children as SemanticNode[]) : [];
    expect(c?.binding?.priority).toBe("P1");
  });

  it("gives two entries over one fact separate providers", () => {
    const e = experience(
      [node("n1", "KeyFigure", "p-a"), node("n2", "FigureChart", "p-a")],
      [planned("p-a", "turn.facts", "docmind:turn.facts@1#fact-0")],
    );
    const out = turnWithVisuals(e, { chatId: CHAT, ord: 6 }, live) as Experience;
    expect(Object.keys(out.providers).sort()).toEqual(["fact-0", "fact-0-b"]);
  });
});
