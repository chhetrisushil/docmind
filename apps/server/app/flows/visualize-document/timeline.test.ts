import { describe, expect, it } from "vitest";
import { MAX_RAW_ITEMS } from "./structureText";
import {
  MAX_EVENTS,
  MAX_EVENT_LABEL,
  MAX_WHEN,
  MIN_EVENTS,
  buildTimeline,
  rawEventsOf,
} from "./timeline";

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
/** Five passages of this document, in document order. */
const POS = new Map([1, 2, 3, 4, 5].map((n, i) => [ID(n), i] as const));
const ev = (date: string, label: string, over: Record<string, unknown> = {}) => ({
  when: date,
  date,
  label,
  chunkIds: [ID(1)],
  ...over,
});
const GOOD = [ev("2024-03", "Alpha"), ev("2025-Q3", "Beta"), ev("2026-02-14", "Gamma")];

describe("buildTimeline", () => {
  it("keeps the limits the spec names", () => {
    expect([MAX_EVENTS, MIN_EVENTS, MAX_WHEN, MAX_EVENT_LABEL, MAX_RAW_ITEMS]).toEqual([
      40, 3, 40, 80, 200,
    ]);
  });

  it("orders events by date whatever order the model gave, keeping each precision and what was written", () => {
    const shuffled = [GOOD[2], GOOD[0], GOOD[1]];
    const t = buildTimeline(shuffled, POS);
    expect(t?.kind).toBe("timeline");
    expect(t?.events).toEqual([
      { at: "2024-03-01", precision: "month", when: "2024-03", label: "Alpha", chunkId: ID(1) },
      { at: "2025-07-01", precision: "quarter", when: "2025-Q3", label: "Beta", chunkId: ID(1) },
      { at: "2026-02-14", precision: "day", when: "2026-02-14", label: "Gamma", chunkId: ID(1) },
    ]);
  });

  it("keeps `when` as the document wrote it, clipped to 40, and falls back to the date when it is missing or empty", () => {
    const t = buildTimeline(
      [
        ev("2024-03", "Alpha", { when: "x".repeat(60) }),
        ev("2025-Q3", "Beta", { when: undefined }),
        ev("2026-02-14", "Gamma", { when: "  " }),
      ],
      POS,
    );
    expect(t?.events.map((e) => e.when)).toEqual(["x".repeat(MAX_WHEN), "2025-Q3", "2026-02-14"]);
  });

  it("drops an event whose date is relative, undated or does not parse, and keeps the others", () => {
    const t = buildTimeline(
      [
        ...GOOD,
        ev("last year", "Relative"),
        ev("2025-13", "Bad month"),
        ev("2025-02-30", "Bad day"),
        ev("", "Empty"),
        { when: "soon", label: "No date field", chunkIds: [ID(1)] },
      ],
      POS,
    );
    expect(t?.events.map((e) => e.label)).toEqual(["Alpha", "Beta", "Gamma"]);
  });

  it("drops an event with no usable label, and one that is not an object", () => {
    const t = buildTimeline(
      [
        ...GOOD,
        ev("2027", " \u200b "),
        ev("2027", ""),
        ev("2027", "x", { label: 7 }),
        null,
        "x",
        3,
      ],
      POS,
    );
    expect(t?.events.map((e) => e.label)).toEqual(["Alpha", "Beta", "Gamma"]);
  });

  it("strips control characters from labels and clips them to 80", () => {
    const t = buildTimeline(
      [ev("2024", "Open\u0000ing\nnight"), ev("2025", "y".repeat(120)), ev("2026", "Third")],
      POS,
    );
    expect(t?.events[0]?.label).toBe("Open ing night");
    expect(t?.events[1]?.label).toBe("y".repeat(MAX_EVENT_LABEL));
  });

  it("cites only passages of this document: foreign and missing citations are removed, and an event with none left is dropped", () => {
    const t = buildTimeline(
      [
        ...GOOD,
        ev("2027", "Foreign", { chunkIds: [ID(99)] }),
        ev("2028", "Empty", { chunkIds: [] }),
        ev("2029", "Missing", { chunkIds: undefined }),
        ev("2030", "Mixed", { chunkIds: [ID(99), ID(3)] }),
      ],
      POS,
    );
    expect(t?.events.map((e) => [e.label, e.chunkId])).toEqual([
      ["Alpha", ID(1)],
      ["Beta", ID(1)],
      ["Gamma", ID(1)],
      ["Mixed", ID(3)],
    ]);
  });

  it("cites the earliest-positioned of an event's passages, and lists each passage once in event order", () => {
    const t = buildTimeline(
      [
        ev("2024", "A", { chunkIds: [ID(3), ID(1)] }),
        ev("2025", "B", { chunkIds: [ID(2)] }),
        ev("2026", "C", { chunkIds: [ID(2), ID(4)] }),
      ],
      POS,
    );
    expect(t?.events.map((e) => e.chunkId)).toEqual([ID(1), ID(2), ID(2)]);
    expect(t?.chunkIds).toEqual([ID(1), ID(2)]);
  });

  it("dedupes by date, precision and normalised label, and keeps events that differ in precision", () => {
    const t = buildTimeline(
      [
        ev("2024-03", "Launch"),
        ev("2024-03", "  LAUNCH "),
        ev("2024", "Launch"),
        ev("2024-03-01", "Launch"),
        ev("2025", "Other"),
        ev("2026", "More"),
      ],
      POS,
    );
    expect(t?.events.map((e) => [e.at, e.precision, e.label])).toEqual([
      ["2024-01-01", "year", "Launch"],
      ["2024-03-01", "month", "Launch"],
      ["2024-03-01", "day", "Launch"],
      ["2025-01-01", "year", "Other"],
      ["2026-01-01", "year", "More"],
    ]);
  });

  it("breaks a tie on the date by the first cited passage's position, then by the model's order", () => {
    const t = buildTimeline(
      [
        ev("2024", "Late passage", { chunkIds: [ID(3)] }),
        ev("2024", "Early passage", { chunkIds: [ID(1)] }),
        ev("2024", "Same passage first", { chunkIds: [ID(2)] }),
        ev("2024", "Same passage second", { chunkIds: [ID(2)] }),
      ],
      POS,
    );
    expect(t?.events.map((e) => e.label)).toEqual([
      "Early passage",
      "Same passage first",
      "Same passage second",
      "Late passage",
    ]);
  });

  it("caps at 40 after sorting, so the 40 earliest survive", () => {
    const raw = Array.from({ length: 45 }, (_, i) => ev(String(2045 - i), `Event ${2045 - i}`));
    const t = buildTimeline(raw, POS);
    expect(t?.events).toHaveLength(MAX_EVENTS);
    expect(t?.events[0]?.at).toBe("2001-01-01");
    expect(t?.events.at(-1)?.at).toBe("2040-01-01");
  });

  it("needs at least 3 events after every drop: 3 is a timeline, 2 and 0 are none", () => {
    expect(buildTimeline(GOOD, POS)).not.toBeNull();
    expect(buildTimeline(GOOD.slice(0, 2), POS)).toBeNull();
    expect(buildTimeline([GOOD[0], GOOD[0], GOOD[1], GOOD[2]].slice(0, 3), POS)).toBeNull(); // a duplicate is not a third event
    expect(buildTimeline([], POS)).toBeNull();
  });

  it("reads at most 200 raw items", () => {
    const junk = Array.from({ length: MAX_RAW_ITEMS }, () => null);
    expect(buildTimeline([...junk, ...GOOD], POS)).toBeNull(); // the good ones sit past the bound
  });
});

describe("rawEventsOf", () => {
  it("reads the events list of a timeline field, and nothing from anything else", () => {
    expect(rawEventsOf({ events: [1, 2] })).toEqual([1, 2]);
    for (const v of [undefined, null, "x", { events: "x" }, { events: null }, {}])
      expect(rawEventsOf(v)).toEqual([]);
  });
  it("reads a bare list as the events", () => {
    expect(rawEventsOf([1, 2])).toEqual([1, 2]);
  });
  it("hands over at most 200 items", () => {
    expect(rawEventsOf({ events: Array.from({ length: 500 }, (_, i) => i) })).toHaveLength(200);
  });
});
