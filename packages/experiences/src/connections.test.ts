import { genesis, replay } from "@loom-ui/core";
import type { Operation, ProviderSpec } from "@loom-ui/core";
import { declaredToolClassesFrom } from "@loom-ui/planner";
import { describe, expect, it, vi } from "vitest";
import {
  CONNECTIONS_HANDLE,
  CONNECTION_ENTRIES,
  CONNECTION_HANDLE,
  bindsConnections,
  clipConnections,
  connectionsCapability,
  connectionsProvider,
  isConnectionEntry,
} from "./connections";
import { INVOKE_ID, type RawConnections, type UiReaders, createInvoker } from "./invoker";
import { CONNECTIONS_CAPS, PINS, provider } from "./providers";
import {
  OWNER_READ,
  TURN_READ,
  type VisualFactRaw,
  capabilitiesOf,
  factCapabilities,
  visualCapabilities,
} from "./visuals";

const DOC = "00000000-0000-4000-8000-0000000000d1";
const FIGURE: VisualFactRaw = {
  kind: "figure",
  label: "Revenue",
  value: 1,
  chunkIds: [],
  ordinal: 0,
};
const raw = (related: number, entities = 0): RawConnections => ({
  documentId: DOC,
  related: Array.from({ length: related }, (_, i) => ({
    documentId: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
    title: `Doc ${i}`,
    kinds: { entity: 1, reference: 0, similar: 0 },
    strength: 0.5,
  })),
  entities: Array.from({ length: entities }, (_, i) => ({
    entityId: `00000000-0000-4000-8000-${String(i + 500).padStart(12, "0")}`,
    name: `Entity ${i}`,
    kind: "organization",
    documents: Array.from({ length: 9 }, (_, j) => ({
      documentId: `00000000-0000-4000-8000-${String(j + 1).padStart(12, "0")}`,
      title: `Doc ${j}`,
    })),
  })),
});
const call = (readers: Partial<UiReaders>, args: unknown) =>
  createInvoker(readers as UiReaders).invokeTransient(INVOKE_ID, {
    target: "doc.connections",
    args,
  });

describe("the connections contract", () => {
  it("pins the tool and names its two entries and handles", () => {
    expect(PINS["doc.connections"]).toBe("docmind:doc.connections@1");
    expect(CONNECTIONS_HANDLE).toBe("connections");
    expect(CONNECTION_ENTRIES).toEqual(["RelatedDocuments", "ConnectionMap"]);
    expect(CONNECTION_HANDLE).toEqual({
      RelatedDocuments: "connections-table",
      ConnectionMap: "connections-map",
    });
    expect(isConnectionEntry("ConnectionMap")).toBe(true);
    expect(isConnectionEntry("KeyFigure")).toBe(false);
    expect(isConnectionEntry("__proto__")).toBe(false);
  });

  it("offers one bindable, sensitive capability with the pin and a content-free sample", () => {
    const c = connectionsCapability();
    expect(c).toMatchObject({
      handle: "connections",
      kind: "docmind",
      toolName: "doc.connections",
      toolVersion: "1.0.0",
      toolSchemaHash: "docmind:doc.connections@1",
      sensitivity: "sensitive",
    });
    expect(c.sampleOutput).toBeDefined();
    expect(JSON.stringify(c.sampleOutput)).not.toMatch(/@|[0-9a-f]{8}-[0-9a-f]{4}/);
  });

  it("is offered with the facts for a document, and never for a chat turn", () => {
    expect(visualCapabilities([FIGURE]).map((c) => c.handle)).toEqual(["fact-0", "connections"]);
    expect(visualCapabilities([]).map((c) => c.handle)).toEqual(["connections"]);
    expect(capabilitiesOf([FIGURE]).map((c) => c.handle)).toEqual(["fact-0"]);
    expect(
      factCapabilities([{ fact: FIGURE, origin: { kind: "turn" } }]).some(
        (c) => c.toolName === "doc.connections",
      ),
    ).toBe(false);
  });

  it("is classified sensitive for the owner's read, and equals what the capabilities declare", () => {
    expect(OWNER_READ.declaredToolClasses["docmind:doc.connections"]).toBe("sensitive");
    expect(declaredToolClassesFrom(visualCapabilities([FIGURE]))).toEqual(
      OWNER_READ.declaredToolClasses,
    );
    expect(Object.keys(TURN_READ.declaredToolClasses)).not.toContain("docmind:doc.connections");
  });

  it("builds a provider whose only argument is the server's document id, with nothing overridable", () => {
    const p = connectionsProvider(DOC, "RelatedDocuments");
    expect(p.handle).toBe("connections-table");
    expect(p.reshaping).toMatchObject({ scriptRef: "connections-table" });
    expect(p.executionGraph[0]).toMatchObject({
      toolName: "doc.connections",
      toolSchemaHash: PINS["doc.connections"],
      arguments: { documentId: DOC },
      overridable: [],
    });
    expect(connectionsProvider(DOC, "ConnectionMap").handle).toBe("connections-map");
  });

  it("recognises a planner binding to connections by direct handle or by the provider's pin, and no other", () => {
    const g = genesis({
      experienceId: "docmind.visuals",
      intent: { objective: "v", source: "user" },
      meta: { author: "planner", createdAt: "2026-11-08T00:00:00Z", sourceKind: "code" },
    });
    const pinned = (handle: string, target: "doc.connections" | "visual.facts") =>
      ({ ...provider(handle, { target, args: {}, reshaper: "x" }), handle }) as ProviderSpec;
    const ops: Operation[] = [
      { type: "remapProvider", handle: "p-conn", spec: pinned("p-conn", "doc.connections") },
      { type: "remapProvider", handle: "p-fact", spec: pinned("p-fact", "visual.facts") },
    ];
    const r = replay(g, ops);
    if (!r.ok) throw new Error("fixture does not replay");
    expect(bindsConnections(r.value, "connections")).toBe(true);
    expect(bindsConnections(r.value, "p-conn")).toBe(true);
    expect(bindsConnections(r.value, "p-fact")).toBe(false);
    expect(bindsConnections(r.value, "nope")).toBe(false);
    expect(bindsConnections(r.value, "__proto__")).toBe(false);
  });

  it("clips a reader's answer to the caps and drops fields it does not know", () => {
    const clipped = clipConnections({ ...raw(20, 20), extra: "x" } as never);
    expect(clipped.related).toHaveLength(CONNECTIONS_CAPS.related);
    expect(clipped.entities).toHaveLength(CONNECTIONS_CAPS.entities);
    expect(clipped.entities[0]?.documents).toHaveLength(CONNECTIONS_CAPS.entityDocuments);
    expect(Object.keys(clipped).sort()).toEqual(["documentId", "entities", "related"]);
  });
});

describe("the doc.connections read through the invoker", () => {
  it("parses the document id (any case), calls the reader once for identical calls and clips an over-long answer", async () => {
    const connections = vi.fn(async () => raw(20, 20));
    const readers = { connections };
    const inv = createInvoker(readers as unknown as UiReaders);
    const ask = (documentId: string) =>
      inv.invokeTransient<unknown, RawConnections>(INVOKE_ID, {
        target: "doc.connections",
        args: { documentId },
      });
    const [a, b] = await Promise.all([ask(DOC.toUpperCase()), ask(DOC)]);
    expect(connections).toHaveBeenCalledTimes(1);
    expect(connections).toHaveBeenCalledWith({ documentId: DOC });
    expect(a.related).toHaveLength(8);
    expect(b.entities).toHaveLength(12);
  });

  it("refuses bad arguments (a wrong type, a missing id, an extra key) before any reader runs", async () => {
    const connections = vi.fn(async () => raw(0));
    for (const args of [{ documentId: "x" }, {}, { documentId: DOC, extra: 1 }, undefined])
      await expect(call({ connections }, args)).rejects.toMatchObject({ channel: "invalidArgs" });
    expect(connections).not.toHaveBeenCalled();
  });

  it("answers notFound for a document the reader does not know", async () => {
    await expect(
      call({ connections: async () => null }, { documentId: DOC }),
    ).rejects.toMatchObject({ channel: "notFound" });
  });
});
