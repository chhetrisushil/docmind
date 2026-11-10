import { type DatePrecision, parseEventDate } from "./dates";
import {
  MAX_RAW_ITEMS,
  MAX_STRUCTURE_LABEL,
  cleanText,
  earliestPassage,
  isRecord,
  nameKey,
} from "./structureText";

export { MAX_RAW_ITEMS };
export const MAX_EVENTS = 40;
export const MIN_EVENTS = 3;
/** `when` is the date as the document wrote it. */
export const MAX_WHEN = 40;
export const MAX_EVENT_LABEL = MAX_STRUCTURE_LABEL;

export interface TimelineEvent {
  /** The ISO first day of the event's period. */
  at: string;
  precision: DatePrecision;
  /** The date as written, at most 40 characters. */
  when: string;
  label: string;
  /** The earliest passage of this document the event cites. */
  chunkId: string;
}
export interface TimelineDraft {
  kind: "timeline";
  events: TimelineEvent[];
  /** The distinct `chunkId`s in event order. */
  chunkIds: string[];
}

/** The raw events of the answer's `timeline` field: its `events` list when it is one, at most 200 items; else none. */
export const rawEventsOf = (field: unknown): unknown[] =>
  isRecord(field) && Array.isArray(field.events) ? field.events.slice(0, MAX_RAW_ITEMS) : [];

/**
 * The timeline of a document from the model's raw events, or null (no timeline). Every bad item is dropped on its own:
 * a `date` that is not a real date at one of the four precisions, an empty label, no cited passage of this document.
 * Survivors are deduped by (`at`, `precision`, normalised label), sorted by `at`, then by the position of the cited passage,
 * then by the model's order, and capped at 40 (the earliest). Fewer than 3 survivors is no timeline. Never throws, never
 * echoes an item. `position` maps this document's passage ids (lower case) to their index in passage order.
 */
export function buildTimeline(
  raw: readonly unknown[],
  position: ReadonlyMap<string, number>,
): TimelineDraft | null {
  const seen = new Set<string>();
  const kept: { event: TimelineEvent; at: number; order: number }[] = [];
  raw.slice(0, MAX_RAW_ITEMS).forEach((item, order) => {
    if (!isRecord(item)) return;
    const date = parseEventDate(item.date);
    const label = typeof item.label === "string" ? cleanText(item.label, MAX_EVENT_LABEL) : "";
    const chunkId = earliestPassage(item.chunkIds, position);
    if (date === null || label === "" || chunkId === null) return;
    const key = `${date.at}|${date.precision}|${nameKey(label)}`;
    if (seen.has(key)) return;
    seen.add(key);
    const written = typeof item.when === "string" ? cleanText(item.when, MAX_WHEN) : "";
    kept.push({
      event: {
        at: date.at,
        precision: date.precision,
        when: written === "" ? String(item.date).trim() : written,
        label,
        chunkId,
      },
      at: position.get(chunkId) as number,
      order,
    });
  });
  kept.sort(
    (a, b) =>
      (a.event.at < b.event.at ? -1 : a.event.at > b.event.at ? 1 : 0) ||
      a.at - b.at ||
      a.order - b.order,
  );
  const events = kept.slice(0, MAX_EVENTS).map((k) => k.event);
  if (events.length < MIN_EVENTS) return null;
  return { kind: "timeline", events, chunkIds: [...new Set(events.map((e) => e.chunkId))] };
}
