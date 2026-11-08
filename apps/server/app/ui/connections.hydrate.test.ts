import { type UiReaders, createViews } from "@docmind/experiences";
import {
  type Experience,
  type Operation,
  type ProviderSpec,
  type SemanticNode,
  genesis,
  replay,
} from "@loom-ui/core";
import { describe, expect, it, vi } from "vitest";
import { FieldKeyStoreError } from "../crypto/fields";

const DOC = "00000000-0000-4000-8000-0000000000d1";

const node = (id: string, order: string, type: string, handle: string): SemanticNode =>
  ({
    id,
    order,
    kind: "semantic",
    type,
    typeVersion: "1.0.0",
    span: 6,
    props: {},
  }) as SemanticNode;

/** A planner-committed head: a connections table and a fact figure, each on its own handle. */
function head(): Experience {
  const g = genesis({
    experienceId: "docmind.visuals",
    intent: { objective: "Visuals", source: "user" },
    meta: { author: "planner", createdAt: "2026-11-08T00:00:00Z", sourceKind: "code" },
  });
  const spec = (handle: string, target: string): ProviderSpec =>
    ({
      handle,
      executionGraph: [
        {
          stepId: "read",
          kind: "docmind",
          toolName: target,
          toolVersion: "1.0.0",
          toolSchemaHash: "x",
          arguments: {},
          dependsOn: [],
          idempotent: true,
          overridable: [],
        },
      ],
      reshaping: { engine: "Named", scriptRef: "x" },
      outputShapeHash: "",
      outputCheck: "contract",
      cachePolicy: { ttlSeconds: 0, scope: "principal" },
    }) as ProviderSpec;
  const ops: Operation[] = [
    { type: "remapProvider", handle: "connections", spec: spec("connections", "doc.connections") },
    { type: "remapProvider", handle: "fact-0", spec: spec("fact-0", "visual.facts") },
    {
      type: "insertNode",
      parentId: g.root.id,
      node: node("rel", "a", "RelatedDocuments", "connections"),
    },
    { type: "insertNode", parentId: g.root.id, node: node("kf", "b", "KeyFigure", "fact-0") },
    { type: "bindProvider", nodeId: "rel", handle: "connections", priority: "P0" },
    { type: "bindProvider", nodeId: "kf", handle: "fact-0", priority: "P0" },
  ];
  const r = replay(g, ops);
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r.value;
}

describe("hydrating connections when the key store is down", () => {
  it("gives the connections widget its error state and a sibling fact widget still renders ready", async () => {
    const views = createViews({ placeholderKey: "k".repeat(32), revisionKey: "r".repeat(32) });
    const h = head();
    const exp = views.documentExperience(DOC, h);
    const p = views.documentPayload(DOC, h, "web");
    const load = (handle: string) => ({
      experienceId: p.experienceId,
      versionHash: p.versionHash,
      handle,
      params: {},
    });
    const connections = vi.fn(async () => {
      throw new FieldKeyStoreError();
    });
    const visualFacts = vi.fn(async () => [
      { kind: "figure", label: "Revenue", value: 4242, chunkIds: [], ordinal: 0 },
    ]);
    const [c, f] = await views.hydrateExperience(
      exp,
      [load("connections-table"), load("fact-0")],
      { connections, visualFacts } as unknown as UiReaders,
      "u",
      "document",
    );
    expect(connections).toHaveBeenCalledWith({ documentId: DOC });
    expect(c?.state).toBe("error");
    expect(JSON.stringify(c)).not.toContain("FieldKeyStoreError");
    expect(f).toMatchObject({ state: "ready" });
    expect(JSON.stringify(f)).toContain("4242");
  });
});
