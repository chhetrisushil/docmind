import type { ChatSessionDto, DocumentDto } from "@docmind/contracts";
import { locatorText } from "@docmind/contracts";
import { defineReshapers } from "@loom-ui/hydration";
import { formatBytes } from "./format";
import type { RawContent, RawDocuments } from "./invoker";
import { CONTENT_STEP, LIST_CAP } from "./providers";

export const STATUS_TEXT: Record<DocumentDto["status"], string> = {
  uploaded: "Queued",
  parsing: "Parsing",
  embedding: "Indexing",
  ready: "Ready",
  failed: "Failed",
};
const PROCESSING = new Set<DocumentDto["status"]>(["uploaded", "parsing", "embedding"]);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const typeOf = (mime: string): string =>
  mime === "application/pdf"
    ? "PDF"
    : mime === "text/plain"
      ? "Text"
      : mime === "text/markdown"
        ? "Markdown"
        : mime.startsWith("image/")
          ? "Image"
          : mime.includes("wordprocessingml") || mime === "application/msword"
            ? "Word"
            : "File";

type Doc = DocumentDto;

const SHAPES: Record<string, (raw: never) => unknown> = {
  "library-total": (raw: RawDocuments) => ({
    value: raw.items.length,
    label: raw.truncated ? `Newest ${LIST_CAP} shown` : "in your library",
  }),
  "library-ready": (raw: RawDocuments) => ({
    value: raw.items.filter((d) => d.status === "ready").length,
    ...(raw.truncated ? { label: `among the newest ${LIST_CAP}` } : {}),
  }),
  "library-health": (raw: RawDocuments) => {
    const min = raw.truncated ? "at least " : "";
    const failed = raw.items.filter((d) => d.status === "failed").length;
    const busy = raw.items.filter((d) => PROCESSING.has(d.status)).length;
    if (failed > 0)
      return {
        level: "critical",
        headline: `${min}${plural(failed, "document", "documents")} failed`,
        detail: "Open the document to retry it.",
      };
    if (busy > 0)
      return {
        level: "warning",
        headline: `${min}${plural(busy, "document", "documents")} being processed`,
        detail: "They appear as Ready when they are done.",
      };
    return {
      level: "ok",
      headline: "Everything is ready",
      ...(raw.truncated ? { detail: `Only the newest ${LIST_CAP} documents are counted.` } : {}),
    };
  },
  "library-table": (raw: RawDocuments) => ({
    columns: ["Name", "Type", "Size", "Status", "Added"],
    rows: raw.items.map((d) => [
      d.title,
      typeOf(d.mime),
      formatBytes(d.sizeBytes),
      STATUS_TEXT[d.status],
      d.createdAt.slice(0, 10),
    ]),
    rowKeys: raw.items.map((d) => d.id),
    rowActions: raw.items.map((d) => [
      { id: "open", label: "Open", primary: true },
      ...(d.status === "ready" ? [{ id: "ask", label: "Ask" }] : []),
      ...(d.status === "failed" ? [{ id: "retry", label: "Retry" }] : []),
      { id: "delete", label: "Delete", destructive: true },
    ]),
  }),
  "detail-status": (d: Doc) => ({
    level: d.status === "ready" ? "ok" : d.status === "failed" ? "critical" : "warning",
    headline: STATUS_TEXT[d.status],
    ...(d.status === "failed" && d.error ? { detail: d.error } : {}),
  }),
  "detail-summary": (d: Doc) =>
    d.summary === null
      ? {
          tldr: "The summary appears when the document is ready.",
          keyPoints: [],
          meta: "",
          questions: [],
        }
      : {
          tldr: d.summary.tldr,
          keyPoints: d.summary.keyPoints.map((text) => ({ text })),
          meta: `Topics: ${d.summary.topics.join(", ")}. Entities: ${d.summary.entities.join(", ")}.`,
          questions: d.summary.suggestedQuestions.map((label, index) => ({ label, index })),
        },
  "detail-words": (d: Doc) =>
    d.stats
      ? { value: d.stats.wordCount, unit: "words" }
      : { value: 0, unit: "words", label: "not ready" },
  "detail-pages": (d: Doc) =>
    d.stats
      ? d.stats.pageCount === null
        ? { value: 0, unit: "pages", label: "not applicable" }
        : { value: d.stats.pageCount, unit: "pages" }
      : { value: 0, unit: "pages", label: "not ready" },
  "detail-minutes": (d: Doc) =>
    d.stats
      ? { value: d.stats.readingTimeMinutes, unit: "min" }
      : { value: 0, unit: "min", label: "not ready" },
  "detail-facts": (d: Doc) => ({
    columns: ["Fact", "Value"],
    rows: d.stats
      ? [
          ...(d.stats.language ? [["Language", d.stats.language]] : []),
          ...d.stats.dates.map((x) => ["Date", x]),
          ...d.stats.numbers.map((x) => ["Number", x]),
          ...d.stats.outline.map((x) => ["Outline", x]),
        ]
      : [],
  }),
  "detail-content": (raw: { content: RawContent; cited: string | undefined }) => {
    const { items, more } = raw.content;
    const first =
      raw.cited === undefined ? undefined : items.find((p) => p.passageId === raw.cited);
    const ordered = first ? [first, ...items.filter((p) => p !== first)] : items;
    return {
      note:
        items.length === 0
          ? "This document has no extracted text."
          : more
            ? `Showing the first ${items.length} passages.`
            : `All ${items.length} passages.`,
      passages: ordered.map((p) => ({
        head: `${p === first ? "Cited passage - " : ""}${[locatorText(p.locator), p.headingPath.join(" > ")].filter((x) => x !== "").join(" - ")}`,
        text: p.text,
      })),
      more: more ? [{ label: `Show ${CONTENT_STEP} more passages` }] : [],
    };
  },
  "sessions-table": (chats: ChatSessionDto[]) => ({
    columns: ["Chat", "Updated"],
    rows: chats.map((c) => [c.title ?? "New chat", (c.lastMessageAt ?? c.createdAt).slice(0, 10)]),
    rowKeys: chats.map((c) => c.id),
    rowActions: chats.map(() => [
      { id: "open", label: "Open", primary: true },
      { id: "rename", label: "Rename" },
      { id: "delete", label: "Delete", destructive: true },
    ]),
  }),
  "host-published": () => {
    throw new Error("a published handle is not served: the page publishes its value");
  },
};

/** One named shape, for tests and for `reshapers`. */
export const shape = (name: string, raw: unknown): unknown =>
  (SHAPES[name] as (r: unknown) => unknown)(raw);
export const reshapers = defineReshapers(
  Object.fromEntries(Object.keys(SHAPES).map((n) => [n, (raw: unknown) => shape(n, raw)])),
);
