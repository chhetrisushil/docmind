import {
  type ContainerNode,
  type Experience,
  type Priority,
  type ProviderSpec,
  type SemanticNode,
  genesis,
} from "@loom-ui/core";
import { seal } from "@loom-ui/core/log";
import { type EntryName, entryVersion } from "./catalog";

export type Child = SemanticNode | ContainerNode;

/** A `LocalizedText`: the key is for a future catalogue of words, the fallback is what M6 shows. */
export const label = (key: string, fallback: string) => ({ key, fallback });

export function widget(o: {
  id: string;
  type: EntryName;
  span?: number;
  handle?: string;
  priority?: Priority;
  props?: Record<string, unknown>;
  title?: string;
}): SemanticNode {
  return {
    id: o.id,
    order: "",
    kind: "semantic",
    type: o.type,
    typeVersion: entryVersion(o.type),
    span: o.span ?? 12,
    props: o.props ?? {},
    ...(o.title !== undefined && { label: label(`ui.${o.id}`, o.title) }),
    ...(o.handle !== undefined && { binding: { handle: o.handle, priority: o.priority ?? "P0" } }),
  };
}

/** A titled section of a tab set: a grid, so its children's spans apply. */
export const panel = (id: string, title: string, children: Child[]): ContainerNode => ({
  id,
  order: "",
  kind: "container",
  direction: "grid",
  span: 12,
  title: label(`ui.${id}`, title),
  children,
});

/** A tab set: the `tabs` role is drawn by `referenceContainers()` on the web and as a titled stack elsewhere. */
export const tabs = (id: string, panels: ContainerNode[]): ContainerNode => ({
  id,
  order: "",
  kind: "container",
  direction: "column",
  span: 12,
  role: "tabs",
  children: panels,
});

function ordered<T extends Child>(nodes: T[]): T[] {
  if (nodes.length > 26)
    throw new Error("compose: at most 26 siblings (the ordering keys are single letters)");
  return nodes.map((n, i) => ({
    ...n,
    order: String.fromCharCode(0x61 + i),
    ...(n.kind === "container" && { children: ordered(n.children as Child[]) }),
  }));
}

/** An experience, sealed (content-addressed). Content-free: nothing a user owns ever enters one. */
export function build(o: {
  id: string;
  objective: string;
  children: Child[];
  providers?: Record<string, ProviderSpec>;
}): Experience {
  const g = genesis({
    experienceId: o.id,
    intent: { objective: o.objective, source: "user" },
    meta: { author: "docmind", createdAt: "2026-10-21T00:00:00Z", sourceKind: "code" },
  });
  return seal({
    ...g,
    root: { ...(g.root as ContainerNode), children: ordered(o.children) },
    providers: o.providers ?? {},
  });
}
