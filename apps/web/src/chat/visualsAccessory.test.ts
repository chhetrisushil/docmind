import type { ChatEntryRef } from "@loom-ui/renderer-lit/chat";
import { describe, expect, it, vi } from "vitest";
import type { VisualsView } from "./visuals";
import { type AccessoryEntry, type StripHost, VisualsAccessories } from "./visualsAccessory";

const view = (over: Partial<VisualsView> = {}): VisualsView => ({
  strip: true,
  action: "Re-visualize",
  busy: false,
  note: null,
  ...over,
});
const make = (): StripHost =>
  Object.assign(document.createElement("div"), {
    chatId: "",
    ord: 0,
    rev: 0,
    view: null,
  }) as StripHost;
const ref = (id: string, role: "user" | "assistant" = "assistant"): ChatEntryRef => ({
  id,
  turn: 1,
  role,
  status: "complete",
});
const entry = (
  id: string,
  ord: number,
  visuals: VisualsView | null,
  over: Partial<AccessoryEntry> = {},
): AccessoryEntry => ({ id, role: "assistant", ord, visualsRev: 0, visuals, ...over });
const make2 = (onVisualize = vi.fn()) => ({
  acc: new VisualsAccessories({ chatId: "c1", make, onVisualize }),
  onVisualize,
});

describe("VisualsAccessories", () => {
  it("serves one host-owned strip per assistant entry that has a view, the same node every time, and null for everything else", () => {
    const { acc } = make2();
    acc.update([
      entry("t1.assistant", 2, view()),
      entry("t2.assistant", 4, null),
      { id: "m1", role: "user", visualsRev: 0, visuals: null },
    ]);
    const strip = acc.render(ref("t1.assistant"));
    expect(strip).toBeInstanceOf(HTMLElement);
    expect(acc.render(ref("t1.assistant"))).toBe(strip);
    expect([
      acc.render(ref("t2.assistant")),
      acc.render(ref("m1", "user")),
      acc.render(ref("t9.assistant")),
    ]).toEqual([null, null, null]);
    expect(strip).toMatchObject({ chatId: "c1", ord: 2, rev: 0, view: view() });
  });
  it("keeps the node when the view changes, and updates it in place", () => {
    const { acc } = make2();
    acc.update([entry("t1.assistant", 2, view())]);
    const strip = acc.render(ref("t1.assistant")) as StripHost;
    acc.update([
      entry("t1.assistant", 2, view({ busy: true, action: "Visualizing…" }), { visualsRev: 1 }),
    ]);
    expect(acc.render(ref("t1.assistant"))).toBe(strip);
    expect(strip).toMatchObject({ rev: 1, view: { busy: true } });
  });
  it("tells subscribers which entry changed: a strip appearing, changing, or going away, and nothing when nothing changed", () => {
    const { acc } = make2();
    const changed = vi.fn();
    const off = acc.subscribe(changed);
    acc.update([entry("t1.assistant", 2, null)]);
    expect(changed).not.toHaveBeenCalled(); // no strip: nothing to redraw
    acc.update([entry("t1.assistant", 2, view())]);
    expect(changed).toHaveBeenLastCalledWith("t1.assistant");
    changed.mockClear();
    acc.update([entry("t1.assistant", 2, view())]);
    expect(changed).not.toHaveBeenCalled();
    acc.update([entry("t1.assistant", 2, view({ note: "Nothing to visualize" }))]);
    expect(changed).toHaveBeenCalledWith("t1.assistant");
    changed.mockClear();
    acc.update([]);
    expect(changed).toHaveBeenCalledWith("t1.assistant");
    expect(acc.render(ref("t1.assistant"))).toBeNull();
    off();
    acc.update([entry("t1.assistant", 2, view())]);
    expect(changed).toHaveBeenCalledTimes(1); // unsubscribed: no further calls
  });
  it("raises onVisualize with the strip's ord, and stops the event there", () => {
    const { acc, onVisualize } = make2();
    acc.update([entry("t1.assistant", 2, view())]);
    const strip = acc.render(ref("t1.assistant")) as StripHost;
    const outer = vi.fn();
    document.body.addEventListener("visualize", outer);
    strip.dispatchEvent(
      new CustomEvent("visualize", { detail: { ord: 2 }, bubbles: true, composed: true }),
    );
    document.body.removeEventListener("visualize", outer);
    expect(onVisualize).toHaveBeenCalledWith(2);
    expect(outer).not.toHaveBeenCalled();
  });
  it("dispose() drops every strip and subscriber", () => {
    const { acc } = make2();
    const changed = vi.fn();
    acc.subscribe(changed);
    acc.update([entry("t1.assistant", 2, view())]);
    acc.dispose();
    changed.mockClear();
    expect(acc.render(ref("t1.assistant"))).toBeNull();
    acc.update([entry("t1.assistant", 2, view())]);
    expect(changed).not.toHaveBeenCalled();
  });
});
