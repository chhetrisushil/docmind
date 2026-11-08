import type { Experience, ProviderSpec } from "@loom-ui/core";
import type { CapabilityRef } from "@loom-ui/planner";
import type { RawConnections } from "./invoker";
import { CONNECTIONS_CAPS, KIND, PINS, provider } from "./providers";

/** The planner's handle for the connections capability: one per document. */
export const CONNECTIONS_HANDLE = "connections";

export const CONNECTION_ENTRIES = ["RelatedDocuments", "ConnectionMap"] as const;
export type ConnectionEntry = (typeof CONNECTION_ENTRIES)[number];
export const isConnectionEntry = (t: string): t is ConnectionEntry =>
  (CONNECTION_ENTRIES as readonly string[]).includes(t);

/** The provider handle a served entry reads, which is also the name of its reshaper. */
export const CONNECTION_HANDLE: Record<ConnectionEntry, string> = {
  RelatedDocuments: "connections-table",
  ConnectionMap: "connections-map",
};

/**
 * The capability the document planner is always offered (K5). Its sample is a made-up, content-free shape of one read: the
 * prompt names no document of the owner's. Sensitive, so the owner's clearance serves it (R27).
 */
export function connectionsCapability(): CapabilityRef {
  const sample: RawConnections = {
    documentId: "",
    related: [
      {
        documentId: "",
        title: "A related document",
        kinds: { entity: 1, reference: 0, similar: 0 },
        strength: 0.5,
      },
    ],
    entities: [
      {
        entityId: "",
        name: "A shared name",
        kind: "organization",
        documents: [{ documentId: "", title: "A related document" }],
      },
    ],
  };
  return {
    handle: CONNECTIONS_HANDLE,
    kind: KIND,
    toolName: "doc.connections",
    toolVersion: "1.0.0",
    toolSchemaHash: PINS["doc.connections"],
    description:
      "the other documents in this library that are related to this one, and the people, organisations and products they share (live: it changes as the library does)",
    sampleOutput: sample,
    sensitivity: "sensitive",
  };
}

/**
 * The provider a connections node is served from: generated here from the entry and the server's own document id, never from the
 * planner's spec. Its only argument is that id and nothing is overridable, so a client cannot point it at another document.
 */
export const connectionsProvider = (documentId: string, entry: ConnectionEntry): ProviderSpec =>
  provider(CONNECTION_HANDLE[entry], {
    target: "doc.connections",
    args: { documentId },
    reshaper: CONNECTION_HANDLE[entry],
  });

/** A planner node binds connections when its handle is `connections`, or names a provider whose step carries the connections pin. */
export function bindsConnections(visuals: Experience, handle: string): boolean {
  if (handle === CONNECTIONS_HANDLE) return true;
  const step = Object.hasOwn(visuals.providers, handle)
    ? visuals.providers[handle]?.executionGraph[0]
    : undefined;
  return (
    step !== undefined &&
    step.toolName === "doc.connections" &&
    step.toolSchemaHash === PINS["doc.connections"]
  );
}

/** A reader's answer cut to the caps, rebuilt field by field so nothing it adds survives. */
export const clipConnections = (raw: RawConnections): RawConnections => ({
  documentId: raw.documentId,
  related: raw.related.slice(0, CONNECTIONS_CAPS.related),
  entities: raw.entities.slice(0, CONNECTIONS_CAPS.entities).map((e) => ({
    ...e,
    documents: e.documents.slice(0, CONNECTIONS_CAPS.entityDocuments),
  })),
});
