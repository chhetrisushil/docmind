import type { ViewName } from "@docmind/contracts";
import type { ContainerNode, Experience, ProviderSpec, SemanticNode } from "@loom-ui/core";
import { CONTENT_VIEW, SOURCES_VIEW, SUMMARY_VIEW, TYPE_VIEW } from "./a2ui";
import { type Child, build, panel, tabs, widget } from "./compose";
import { CONTENT_STEP, LIST_CAP, provider } from "./providers";
import { MAX_VISUAL_FACTS, type VisualEntry, factProvider } from "./visuals";

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
const FACT_PIN = /^docmind:visual\.facts@1#fact-(0|[1-9]\d*)$/;

/** The fact a bound node reads: its `fact-<n>` handle, or the `#fact-<n>` pin of the planner's provider for that handle. */
function factOrdinal(visuals: Experience, handle: string): number | null {
  const direct = FACT_HANDLE.exec(handle);
  if (direct) return Number(direct[1]);
  const step = Object.hasOwn(visuals.providers, handle)
    ? visuals.providers[handle]?.executionGraph[0]
    : undefined;
  const m = step?.toolName === "visual.facts" ? FACT_PIN.exec(step.toolSchemaHash ?? "") : null;
  return m ? Number(m[1]) : null;
}

/**
 * The per-document detail: the static detail plus a Visuals tab holding a planner-composed
 * visuals experience's nodes. Providers are always generated here from each node's entry and the
 * real document id; any the planner declared are ignored. Two nodes binding one fact with
 * different entries get separate providers (`fact-n-b`, `-c`, ...). Malformed nodes are dropped,
 * never thrown on: this runs on every detail page load.
 */
export function detailWithVisuals(visuals: Experience | null, documentId: string): Experience {
  if (visuals === null) return EXPERIENCES.detail;
  const providers: Record<string, ProviderSpec> = detailProviders();
  const entryOf = new Map<string, VisualEntry>();
  const copy = (n: Child): Child | null => {
    if (n.kind === "container") {
      const children = (n.children as Child[])
        .slice(0, MAX_SIBLINGS)
        .map(copy)
        .filter((c): c is Child => c !== null);
      return children.length === 0 ? null : { ...n, id: `v-${n.id}`, children };
    }
    const ordinal = n.binding ? factOrdinal(visuals, n.binding.handle) : null;
    if (
      !n.binding ||
      ordinal === null ||
      ordinal >= MAX_VISUAL_FACTS ||
      !VISUAL_ENTRIES.has(n.type)
    )
      return null;
    const entry = n.type as VisualEntry;
    const base = `fact-${ordinal}`;
    let handle = base;
    for (let i = 0; (entryOf.get(handle) ?? entry) !== entry; i++)
      handle = `${base}-${String.fromCharCode(0x62 + i)}`;
    if (!entryOf.has(handle)) {
      entryOf.set(handle, entry);
      providers[handle] = { ...factProvider(ordinal, documentId, entry), handle };
    }
    // The planner marks its bindings `sensitive` (so its summary is not withheld); served to the document's owner, that
    // class would make hydration treat the handle as restricted and refuse it, so the served binding does not carry it.
    const { sensitivity: _dropped, ...binding } = n.binding;
    return { ...n, id: `v-${n.id}`, binding: { ...binding, handle } };
  };
  const kept = (visuals.root as ContainerNode).children
    .slice(0, MAX_SIBLINGS)
    .map((c) => copy(c as Child))
    .filter((c): c is Child => c !== null);
  if (kept.length === 0) return EXPERIENCES.detail;
  return build({
    id: "docmind.detail",
    objective: "Document",
    children: detailChildren([panel("visuals", "Visuals", kept)]),
    providers,
  });
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
