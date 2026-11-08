import {
  type ContainerNode,
  type Experience,
  type ExperienceNode,
  type Operation,
  type ProviderSpec,
  type SemanticNode,
  compile,
  genesis,
  replay,
} from "@loom-ui/core";
import { HYDRATION_PROJECTION_ID, HYDRATION_PROJECTION_VERSION } from "@loom-ui/hydration";
import { describe, expect, it, vi } from "vitest";
import { connectionsProvider } from "./connections";
import type { RawConnections, UiReaders } from "./invoker";
import { PINS, provider } from "./providers";
import { detailWithVisuals, turnWithVisuals } from "./views";
import { createViews } from "./views-api";
import { OWNER_READ, factProvider, mergedCatalog } from "./visuals";

const DOC = "00000000-0000-4000-8000-0000000000d1";
const OTHER = "00000000-0000-4000-8000-0000000000d9";
const REL = "00000000-0000-4000-8000-0000000000b1";
const KEY = "k".repeat(32);

const node = (id: string, type: string, handle: string, priority = "P0"): SemanticNode =>
  ({
    id,
    order: id,
    kind: "semantic",
    type,
    typeVersion: "1.0.0",
    span: 12,
    props: {},
    binding: { handle, priority },
  }) as SemanticNode;

/** What the planner commits: a provider per handle and nodes bound to them. */
const experienceOf = (
  nodes: SemanticNode[],
  specOf: (handle: string) => ProviderSpec,
): Experience => {
  const g = genesis({
    experienceId: "docmind.visuals",
    intent: { objective: "Visuals", source: "user" },
    meta: { author: "planner", createdAt: "2026-11-08T00:00:00Z", sourceKind: "code" },
  });
  const ops: Operation[] = [];
  for (const h of new Set(nodes.map((n) => n.binding?.handle as string)))
    ops.push({ type: "remapProvider", handle: h, spec: { ...specOf(h), handle: h } });
  nodes.forEach((n, i) =>
    ops.push({
      type: "insertNode",
      parentId: g.root.id,
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
const committed = (h: string): ProviderSpec =>
  h === "connections"
    ? (provider(h, { target: "doc.connections", args: {}, reshaper: "x" }) as ProviderSpec)
    : factProvider(0, "planner-guess", "KeyFigure");

const both = () =>
  experienceOf(
    [node("rel", "RelatedDocuments", "connections"), node("map", "ConnectionMap", "connections")],
    committed,
  );

const find = (n: ExperienceNode, id: string): ExperienceNode | undefined =>
  n.id === id
    ? n
    : n.kind === "container"
      ? (n.children as ExperienceNode[]).map((c) => find(c, id)).find((x) => x)
      : undefined;

describe("detailWithVisuals with connections", () => {
  it("adopts both entries onto their own provider, generated from the server's document id", () => {
    const exp = detailWithVisuals(both(), DOC);
    const panel = find(exp.root, "visuals") as ContainerNode;
    expect(panel.children.map((c) => c.id)).toEqual(["v-rel", "v-map"]);
    expect(exp.providers["connections-table"]).toEqual(
      connectionsProvider(DOC, "RelatedDocuments"),
    );
    expect(exp.providers["connections-map"]).toEqual(connectionsProvider(DOC, "ConnectionMap"));
    expect(exp.providers["connections-table"]?.executionGraph[0]).toMatchObject({
      toolName: "doc.connections",
      toolSchemaHash: PINS["doc.connections"],
      arguments: { documentId: DOC },
      overridable: [],
    });
    const rel = find(exp.root, "v-rel") as SemanticNode;
    expect(rel.binding?.handle).toBe("connections-table");
    expect(rel.binding?.sensitivity).toBe("sensitive");
    expect((find(exp.root, "v-map") as SemanticNode).binding?.handle).toBe("connections-map");
  });

  it("binds a planner P2 connections node at P1, so the web requests it", () => {
    const e = experienceOf([node("rel", "RelatedDocuments", "connections", "P2")], committed);
    const rel = find(detailWithVisuals(e, DOC).root, "v-rel") as SemanticNode;
    expect(rel.binding?.priority).toBe("P1");
  });

  it("drops a connections entry that binds a fact provider, and keeps a fact node beside connections", () => {
    const mixed = experienceOf(
      [
        node("bad", "RelatedDocuments", "fact-0"),
        node("kf", "KeyFigure", "fact-0"),
        node("rel", "RelatedDocuments", "connections"),
      ],
      committed,
    );
    const panel = find(detailWithVisuals(mixed, DOC).root, "visuals") as ContainerNode;
    expect(panel.children.map((c) => c.id)).toEqual(["v-kf", "v-rel"]);
  });

  it("drops a non-connections entry bound to a handle whose provider carries the doc.connections pin", () => {
    const e = experienceOf(
      [node("kf", "KeyFigure", "connections"), node("rel", "RelatedDocuments", "connections")],
      committed,
    );
    const panel = find(detailWithVisuals(e, DOC).root, "visuals") as ContainerNode;
    expect(panel.children.map((c) => c.id)).toEqual(["v-rel"]);
  });

  it("is the static detail when the only nodes are connections entries that bind nothing real", () => {
    const e = experienceOf([node("bad", "ConnectionMap", "fact-0")], committed);
    expect(find(detailWithVisuals(e, DOC).root, "visuals")).toBeUndefined();
  });

  it("compiles for web and terminal with no findings", () => {
    for (const surface of ["web", "terminal"] as const) {
      const r = compile(detailWithVisuals(both(), DOC), {
        surface,
        catalog: mergedCatalog(),
        hydrationProjectionId: HYDRATION_PROJECTION_ID,
        hydrationProjectionVersion: HYDRATION_PROJECTION_VERSION,
        viewer: OWNER_READ.viewer,
        audience: OWNER_READ.audience,
        declaredToolClasses: OWNER_READ.declaredToolClasses,
        placeholderKey: KEY,
      });
      expect(r.findings).toEqual([]);
      const json = JSON.stringify(r);
      expect(json).toContain("v-rel");
      expect(json).toContain("v-map");
    }
  });

  it("is never adopted for a chat turn (K7)", () => {
    const turn = { chatId: "00000000-0000-4000-8000-0000000000c1", ord: 1 };
    expect(turnWithVisuals(both(), turn, new Set([DOC]))).toBeNull();
  });
});

describe("a head planned before connections existed", () => {
  it("still compiles and hydrates its fact widgets under the current document catalogue", async () => {
    const views = createViews({ placeholderKey: KEY, revisionKey: "r".repeat(32) });
    const head = experienceOf([node("kf", "KeyFigure", "fact-0")], committed);
    const exp = views.documentExperience(DOC, head);
    expect(find(exp.root, "v-kf")).toBeDefined();
    const p = views.documentPayload(DOC, head, "web");
    const visualFacts = vi.fn(async () => [
      { kind: "figure", label: "Revenue", value: 4242, chunkIds: [], ordinal: 0 },
    ]);
    const [f] = await views.hydrateExperience(
      exp,
      [{ experienceId: p.experienceId, versionHash: p.versionHash, handle: "fact-0", params: {} }],
      { visualFacts } as unknown as UiReaders,
      "u",
      "document",
    );
    expect(f).toMatchObject({ state: "ready" });
    expect(JSON.stringify(f)).toContain("4242");
  });
});

describe("hydrating connections", () => {
  const RAW: RawConnections = {
    documentId: DOC,
    related: [
      {
        documentId: REL,
        title: "Contract B",
        kinds: { entity: 1, reference: 0, similar: 0 },
        strength: 0.8,
      },
    ],
    entities: [
      {
        entityId: "00000000-0000-4000-8000-0000000000e1",
        name: "Acme Corp",
        kind: "organization",
        documents: [{ documentId: REL, title: "Contract B" }],
      },
    ],
  };
  const views = createViews({ placeholderKey: KEY, revisionKey: "r".repeat(32) });
  const setup = () => {
    const head = both();
    const exp = views.documentExperience(DOC, head);
    const payload = views.documentPayload(DOC, head, "web");
    const load = (handle: string, params: Record<string, string | number> = {}) => ({
      experienceId: payload.experienceId,
      versionHash: payload.versionHash,
      handle,
      params,
    });
    return { exp, payload, load };
  };

  it("lists both handles in the served inventory and hydrates both from one read, under the owner's clearance", async () => {
    const { exp, payload, load } = setup();
    expect(payload.inventory.handles.map((h) => h.handle)).toEqual(
      expect.arrayContaining(["connections-table", "connections-map"]),
    );
    expect(payload.fingerprint.restrictedHandles).toEqual([]);
    const connections = vi.fn(async () => RAW);
    const [t, m] = await views.hydrateExperience(
      exp,
      [load("connections-table"), load("connections-map")],
      { connections } as unknown as UiReaders,
      "u",
      "document",
    );
    expect(connections).toHaveBeenCalledTimes(1);
    expect(connections).toHaveBeenCalledWith({ documentId: DOC });
    expect(t).toMatchObject({
      state: "ready",
      value: { rowKeys: [REL], rows: [["Contract B", "shares Acme Corp", 0.8]] },
    });
    expect(m).toMatchObject({ state: "ready", value: { layout: "network" } });
  });

  it("is refused without the owner's clearance, and never reads", async () => {
    const { exp, load } = setup();
    const connections = vi.fn(async () => RAW);
    const [t] = await views.hydrateExperience(
      exp,
      [load("connections-table")],
      { connections } as unknown as UiReaders,
      "u",
    );
    expect(t?.state).toBe("error");
    expect(connections).not.toHaveBeenCalled();
  });

  it("takes its document only from the server's view: a client parameter never reaches the reader", async () => {
    const { exp, load } = setup();
    const connections = vi.fn(async () => RAW);
    await views.hydrateExperience(
      exp,
      [load("connections-table", { documentId: OTHER })],
      { connections } as unknown as UiReaders,
      "u",
      "document",
    );
    expect(connections).toHaveBeenCalledWith({ documentId: DOC });
    expect(connections).not.toHaveBeenCalledWith({ documentId: OTHER });
  });

  it("never passes a planner-emitted provider through: a literal foreign document id is replaced by the view's own", async () => {
    const foreign = (h: string) =>
      provider(h, {
        target: "doc.connections",
        args: { documentId: OTHER },
        reshaper: "connections-table",
      }) as ProviderSpec;
    // once under the planner's `connections` handle, once under its own pin-carrying handle
    for (const handle of ["connections", "planner-conn"]) {
      const head = experienceOf([node("rel", "RelatedDocuments", handle)], foreign);
      const exp = views.documentExperience(DOC, head);
      expect(exp.providers["connections-table"]).toEqual(
        connectionsProvider(DOC, "RelatedDocuments"),
      );
      expect(JSON.stringify(exp.providers)).not.toContain(OTHER);
      const payload = views.documentPayload(DOC, head, "web");
      const connections = vi.fn(async () => RAW);
      const [t] = await views.hydrateExperience(
        exp,
        [
          {
            experienceId: payload.experienceId,
            versionHash: payload.versionHash,
            handle: "connections-table",
            params: {},
          },
        ],
        { connections } as unknown as UiReaders,
        "u",
        "document",
      );
      expect(t?.state).toBe("ready");
      expect(connections).toHaveBeenCalledTimes(1);
      expect(connections).toHaveBeenCalledWith({ documentId: DOC });
    }
  });

  it("gives a failing read its own error state while another widget still renders", async () => {
    // two handles hydrate from the one connections read; a sibling fact widget has its own reader
    const connections = vi.fn(async () => {
      throw new Error("down");
    });
    const mixedHead = experienceOf(
      [
        node("rel", "RelatedDocuments", "connections"),
        node("map", "ConnectionMap", "connections"),
        node("kf", "KeyFigure", "fact-0"),
      ],
      committed,
    );
    const mixed = views.documentExperience(DOC, mixedHead);
    const p = views.documentPayload(DOC, mixedHead, "web");
    const ld = (handle: string) => ({
      experienceId: p.experienceId,
      versionHash: p.versionHash,
      handle,
      params: {},
    });
    const visualFacts = vi.fn(async () => [
      { kind: "figure", label: "Revenue", value: 7, chunkIds: [], ordinal: 0 },
    ]);
    const [t, m, f] = await views.hydrateExperience(
      mixed,
      [ld("connections-table"), ld("connections-map"), ld("fact-0")],
      { connections, visualFacts } as unknown as UiReaders,
      "u",
      "document",
    );
    expect(t?.state).toBe("error");
    expect(m?.state).toBe("error");
    expect(f?.state).toBe("ready");
  });

  it("answers an empty library with the empty states", async () => {
    const { exp, load } = setup();
    const connections = vi.fn(async () => ({ documentId: DOC, related: [], entities: [] }));
    const [t, m] = await views.hydrateExperience(
      exp,
      [load("connections-table"), load("connections-map")],
      { connections } as unknown as UiReaders,
      "u",
      "document",
    );
    expect(t).toMatchObject({
      state: "ready",
      value: { rows: [["No connected documents yet", "", ""]] },
    });
    expect(m).toMatchObject({ state: "ready" });
    expect((m as { value: { nodes: unknown[] } }).value.nodes).toHaveLength(1);
  });
});
