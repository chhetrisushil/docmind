import type { ViewName } from "@docmind/contracts";
import type { ContainerNode, Experience, ProviderSpec, SemanticNode } from "@loom-ui/core";
import { CONTENT_VIEW, SOURCES_VIEW, SUMMARY_VIEW, TYPE_VIEW } from "./a2ui";
import { type Child, build, panel, tabs, widget } from "./compose";
import {
  CONNECTION_HANDLE,
  bindsConnections,
  connectionsProvider,
  isConnectionEntry,
} from "./connections";
import { CONTENT_STEP, LIST_CAP, provider } from "./providers";
import {
  type FactRef,
  MAX_VISUAL_FACTS,
  type VisualEntry,
  factProvider,
  factRefOfPin,
  turnFactProvider,
} from "./visuals";

const published = (handle: string) =>
  provider(handle, { target: "host.published", args: {}, reshaper: "host-published" });
const doc = (handle: string, reshaper: string) =>
  provider(handle, { target: "document.get", args: { id: "" }, overridable: ["id"], reshaper });
const summary = (handle: string, reshaper: string) =>
  provider(handle, { target: "documents.list", args: { limit: LIST_CAP }, reshaper });

const library = (): Experience =>
  build({
    id: "docmind.library",
    objective: "Documents",
    children: [
      widget({ id: "total", type: "LibraryKpi", span: 4, handle: "doc-total", title: "Documents" }),
      widget({ id: "ready", type: "LibraryKpi", span: 4, handle: "doc-ready", title: "Ready" }),
      widget({
        id: "health",
        type: "IngestHealth",
        span: 4,
        handle: "ingest",
        title: "Processing",
      }),
      widget({
        id: "filter",
        type: "StatusFilter",
        span: 12,
        props: {
          label: "Show",
          options: [
            { value: "all", label: "All documents" },
            { value: "ready", label: "Ready" },
            { value: "processing", label: "Processing" },
            { value: "failed", label: "Failed" },
          ],
        },
      }),
      widget({
        id: "table",
        type: "DocumentTable",
        span: 12,
        handle: "documents",
        title: "All documents",
      }),
    ],
    providers: {
      "doc-total": summary("doc-total", "library-total"),
      "doc-ready": summary("doc-ready", "library-ready"),
      ingest: summary("ingest", "library-health"),
      documents: provider("documents", {
        target: "documents.list",
        args: { limit: LIST_CAP, status: "all" },
        overridable: ["status"],
        reshaper: "library-table",
      }),
    },
  });

const libraryEmpty = (): Experience =>
  build({
    id: "docmind.library-empty",
    objective: "Documents",
    children: [
      widget({
        id: "empty",
        type: "Notice",
        props: {
          text: "No documents yet. Drop a file in the box above, or choose browse. DocMind reads it, and then you can ask questions about it.",
        },
      }),
    ],
  });

/** The static detail's children; `extraPanels` are appended to its tab set after Content. */
const detailChildren = (extraPanels: ContainerNode[] = []): Child[] => [
  widget({
    id: "status",
    type: "DocumentHealth",
    span: 12,
    handle: "doc-status",
    title: "Status",
  }),
  tabs("tabs", [
    panel("summary", "Summary", [
      widget({
        id: "summary-view",
        type: "DocumentSummary",
        handle: "doc-summary",
        props: { view: SUMMARY_VIEW },
      }),
    ]),
    panel("analysis", "Analysis", [
      widget({
        id: "words",
        type: "DocumentKpi",
        span: 4,
        handle: "doc-words",
        priority: "P1",
        title: "Words",
      }),
      widget({
        id: "pages",
        type: "DocumentKpi",
        span: 4,
        handle: "doc-pages",
        priority: "P1",
        title: "Pages",
      }),
      widget({
        id: "minutes",
        type: "DocumentKpi",
        span: 4,
        handle: "doc-minutes",
        priority: "P1",
        title: "Reading time",
      }),
      widget({
        id: "facts",
        type: "DocumentFacts",
        span: 12,
        handle: "doc-facts",
        priority: "P1",
        title: "Facts",
      }),
    ]),
    panel("content", "Content", [
      widget({
        id: "content-type",
        type: "DocumentType",
        handle: "doc-type",
        priority: "P1",
        props: { view: TYPE_VIEW },
      }),
      widget({
        id: "content-prose",
        type: "DocumentProse",
        handle: "doc-source",
        priority: "P1",
      }),
      widget({
        id: "content-view",
        type: "DocumentContent",
        handle: "doc-content",
        priority: "P1",
        props: { view: CONTENT_VIEW },
      }),
    ]),
    ...extraPanels,
  ]),
];

const detailProviders = (): Record<string, ProviderSpec> => ({
  "doc-status": doc("doc-status", "detail-status"),
  "doc-summary": doc("doc-summary", "detail-summary"),
  "doc-words": doc("doc-words", "detail-words"),
  "doc-pages": doc("doc-pages", "detail-pages"),
  "doc-minutes": doc("doc-minutes", "detail-minutes"),
  "doc-facts": doc("doc-facts", "detail-facts"),
  "doc-type": doc("doc-type", "detail-type"),
  "doc-source": provider("doc-source", {
    target: "document.source",
    args: { id: "", passage: "" },
    overridable: ["id", "passage"],
    reshaper: "detail-source",
  }),
  "doc-content": provider("doc-content", {
    target: "document.content",
    args: { id: "", upto: CONTENT_STEP, passage: "" },
    overridable: ["id", "upto", "passage"],
    reshaper: "detail-content",
  }),
});

const detail = (): Experience =>
  build({
    id: "docmind.detail",
    objective: "Document",
    children: detailChildren(),
    providers: detailProviders(),
  });

const VISUAL_ENTRIES = new Set<string>(["FigureChart", "FigureTrend", "KeyFigure", "FactTable"]);
const MAX_SIBLINGS = 26;
const FACT_HANDLE = /^fact-(0|[1-9]\d*)$/;

/** The fact a bound node reads: a direct `fact-<n>` handle (detail only), or the pin on the provider of that handle. */
function factRefOf(visuals: Experience, handle: string, direct: boolean): FactRef | null {
  if (direct) {
    const d = FACT_HANDLE.exec(handle);
    if (d) return { kind: "detail", ordinal: Number(d[1]) };
  }
  const step = Object.hasOwn(visuals.providers, handle)
    ? visuals.providers[handle]?.executionGraph[0]
    : undefined;
  return step ? factRefOfPin(step.toolName, step.toolSchemaHash ?? "") : null;
}

/** `R`: the refs the host accepts (a detail page only takes detail refs, a turn only doc and turn refs). */
type DetailFactRef = Extract<FactRef, { kind: "detail" }>;
type TurnFactRef = Exclude<FactRef, { kind: "detail" }>;

interface Adopt<R extends FactRef> {
  refOf(visuals: Experience, handle: string): R | null;
  /** The provider handle of a distinct fact in the host experience. */
  baseHandle(ref: R): string;
  /** The handle in the returned spec is replaced by the adopted one. */
  provider(ref: R, entry: VisualEntry): ProviderSpec;
  /** The document page only: connections entries are adopted onto providers made from this (the server's own) document id. */
  connections?: { documentId: string };
}

/**
 * Copies the planner's nodes into a host experience. Providers are always generated here from each node's entry and
 * the real ids; any the planner declared are ignored. Two nodes binding one fact with different entries get separate
 * providers (`<base>-b`, `-c`, ...). Malformed nodes are dropped, never thrown on: this runs on every page load.
 */
function adoptVisuals<R extends FactRef>(
  visuals: Experience,
  o: Adopt<R>,
  providers: Record<string, ProviderSpec>,
): Child[] {
  const entryOf = new Map<string, VisualEntry>();
  const copy = (n: Child): Child | null => {
    if (n.kind === "container") {
      const children = (n.children as Child[])
        .slice(0, MAX_SIBLINGS)
        .map(copy)
        .filter((c): c is Child => c !== null);
      return children.length === 0 ? null : { ...n, id: `v-${n.id}`, children };
    }
    if (o.connections !== undefined && isConnectionEntry(n.type)) {
      // A connections entry binds the connections capability and nothing else; its provider is generated, never the planner's,
      // and its classification is always the capability's own (sensitive), whatever the planner wrote.
      if (!n.binding || !bindsConnections(visuals, n.binding.handle)) return null;
      const handle = CONNECTION_HANDLE[n.type];
      providers[handle] = connectionsProvider(o.connections.documentId, n.type);
      const priority = n.binding.priority === "P0" ? "P0" : "P1";
      return {
        ...n,
        id: `v-${n.id}`,
        binding: { ...n.binding, handle, priority, sensitivity: "sensitive" },
      };
    }
    // Fact nodes keep the planner's sensitivity while connections nodes are forced above: safe, because the production route
    // serves a document under the OWNER_READ floor, which classifies every fact handle's tool as sensitive whatever the node says.
    const ref = n.binding ? o.refOf(visuals, n.binding.handle) : null;
    if (
      !n.binding ||
      ref === null ||
      ref.ordinal >= MAX_VISUAL_FACTS ||
      !VISUAL_ENTRIES.has(n.type)
    )
      return null;
    const entry = n.type as VisualEntry;
    const base = o.baseHandle(ref);
    let handle = base;
    for (let i = 0; (entryOf.get(handle) ?? entry) !== entry; i++)
      handle = `${base}-${String.fromCharCode(0x62 + i)}`;
    if (!entryOf.has(handle)) {
      entryOf.set(handle, entry);
      providers[handle] = { ...o.provider(ref, entry), handle };
    }
    // The web reports no visibility, so a P2 handle would never be requested: bind at most at P1.
    const priority = n.binding.priority === "P0" ? "P0" : "P1";
    return { ...n, id: `v-${n.id}`, binding: { ...n.binding, handle, priority } };
  };
  return (visuals.root as ContainerNode).children
    .slice(0, MAX_SIBLINGS)
    .map((c) => copy(c as Child))
    .filter((c): c is Child => c !== null);
}

/**
 * The per-document detail: the static detail plus a Visuals tab holding a planner-composed
 * visuals experience's nodes (see `adoptVisuals`). Never throws: this runs on every detail page load.
 */
export function detailWithVisuals(visuals: Experience | null, documentId: string): Experience {
  if (visuals === null) return EXPERIENCES.detail;
  const providers: Record<string, ProviderSpec> = detailProviders();
  const kept = adoptVisuals(
    visuals,
    {
      refOf: (v, h): DetailFactRef | null => {
        const r = factRefOf(v, h, true);
        return r?.kind === "detail" ? r : null; // a turn pin means nothing on a document's page
      },
      baseHandle: (r) => `fact-${r.ordinal}`,
      provider: (r, entry) => factProvider(r.ordinal, documentId, entry),
      connections: { documentId },
    },
    providers,
  );
  if (kept.length === 0) return EXPERIENCES.detail;
  return build({
    id: "docmind.detail",
    objective: "Document",
    children: detailChildren([panel("visuals", "Visuals", kept)]),
    providers,
  });
}

/**
 * A chat turn's visuals as an experience of their own (no detail chrome): the planner's nodes, with providers made
 * from each node's pin (a stored fact reads its document, an extracted fact reads the turn). A stored fact whose
 * document is no longer the user's (`liveDocuments`) drops out. Null when nothing is left.
 */
export function turnWithVisuals(
  visuals: Experience | null,
  turn: { chatId: string; ord: number },
  liveDocuments: ReadonlySet<string>,
): Experience | null {
  if (visuals === null) return null;
  const providers: Record<string, ProviderSpec> = {};
  const base = new Map<string, string>();
  const keyOf = (r: TurnFactRef) =>
    r.kind === "doc" ? `${r.documentId}/${r.ordinal}` : `turn/${r.ordinal}`;
  const kept = adoptVisuals(
    visuals,
    {
      refOf: (v, h): TurnFactRef | null => {
        const r = factRefOf(v, h, false);
        if (r === null || r.kind === "detail") return null;
        return r.kind === "doc" && !liveDocuments.has(r.documentId) ? null : r;
      },
      baseHandle: (r) => {
        const k = keyOf(r);
        if (!base.has(k)) base.set(k, `fact-${base.size}`);
        return base.get(k) as string;
      },
      provider: (r, entry) => turnFactProvider(r, turn, entry),
    },
    providers,
  );
  if (kept.length === 0) return null;
  return build({ id: "docmind.turn", objective: "Answer visuals", children: kept, providers });
}

/** The distinct documents the planner's providers name by their stored-fact pins, in provider order. */
export function documentsOfVisuals(visuals: Experience): string[] {
  const out = new Set<string>();
  for (const p of Object.values(visuals.providers)) {
    const step = p.executionGraph[0];
    const ref = step ? factRefOfPin(step.toolName, step.toolSchemaHash ?? "") : null;
    if (ref?.kind === "doc") out.add(ref.documentId);
  }
  return [...out];
}

const sessions = (): Experience =>
  build({
    id: "docmind.sessions",
    objective: "Chats",
    children: [
      widget({
        id: "search",
        type: "ChatSearch",
        props: {
          label: "Search chats",
          placeholder: "Search chats",
          submitLabel: "Search",
          maxChars: 100,
        },
      }),
      widget({ id: "chats", type: "ChatTable", handle: "chats", title: "Chats" }),
    ],
    providers: {
      chats: provider("chats", {
        target: "chats.list",
        args: { q: "" },
        overridable: ["q"],
        reshaper: "sessions-table",
      }),
    },
  });

const chat = (): Experience =>
  build({
    id: "docmind.chat",
    objective: "Chat",
    children: [
      widget({
        id: "transcript",
        type: "Transcript",
        handle: "transcript",
        priority: "P2",
        title: "Conversation",
        props: { emptyText: "Ask a question about your documents." },
      }),
      widget({
        id: "scope",
        type: "ScopeSelect",
        handle: "chatScope",
        priority: "P2",
        props: {
          label: "Search in",
          emptyLabel: "All documents",
          placeholder: "Add a document…",
          maxSelected: 100,
        },
      }),
      widget({
        id: "composer",
        type: "Composer",
        props: {
          label: "Message",
          placeholder: "Ask about your documents",
          multiline: true,
          maxChars: 4000,
          submitLabel: "Send",
        },
      }),
    ],
    providers: { transcript: published("transcript"), chatScope: published("chatScope") },
  });

const sources = (): Experience =>
  build({
    id: "docmind.sources",
    objective: "Sources",
    children: [
      widget({
        id: "panel",
        type: "SourcesPanel",
        handle: "sources",
        priority: "P2",
        title: "Sources",
        props: { view: SOURCES_VIEW },
      }),
    ],
    providers: { sources: published("sources") },
  });

export const EXPERIENCES: Record<ViewName, Experience> = {
  library: library(),
  "library-empty": libraryEmpty(),
  detail: detail(),
  sessions: sessions(),
  chat: chat(),
  sources: sources(),
};
