import type { ViewName } from "@docmind/contracts";
import type { Experience } from "@loom-ui/core";
import { CONTENT_VIEW, SOURCES_VIEW, SUMMARY_VIEW } from "./a2ui";
import { build, panel, tabs, widget } from "./compose";
import { CONTENT_STEP, LIST_CAP, provider } from "./providers";

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

const detail = (): Experience =>
  build({
    id: "docmind.detail",
    objective: "Document",
    children: [
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
      ]),
    ],
    providers: {
      "doc-status": doc("doc-status", "detail-status"),
      "doc-summary": doc("doc-summary", "detail-summary"),
      "doc-words": doc("doc-words", "detail-words"),
      "doc-pages": doc("doc-pages", "detail-pages"),
      "doc-minutes": doc("doc-minutes", "detail-minutes"),
      "doc-facts": doc("doc-facts", "detail-facts"),
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
    },
  });

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
