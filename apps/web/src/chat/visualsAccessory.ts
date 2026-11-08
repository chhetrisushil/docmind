import type { ChatEntryAccessories, ChatEntryRef } from "@loom-ui/renderer-lit/chat";
import type { VisualsView } from "./visuals";

/** The element the page puts under a reply: `<dm-turn-visuals>` in the app, a stand-in in tests. */
export interface StripHost extends HTMLElement {
  chatId: string;
  ord: number;
  rev: number;
  view: VisualsView | null;
}

/** What the accessories need of a transcript entry (a structural subset of `EntryView`). */
export interface AccessoryEntry {
  id: string;
  role: "user" | "assistant";
  ord?: number;
  visualsRev: number;
  visuals: VisualsView | null;
}

const same = (a: VisualsView | null, b: VisualsView | null) =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.strip === b.strip &&
    a.action === b.action &&
    a.busy === b.busy &&
    a.note === b.note);

/**
 * loom-ui's `ChatEntryAccessories` for one chat page: a map `entryId -> host-owned strip node` (the id is
 * `t<turn>.assistant`). `lu-chat` asks `render` once per entry and status and again on `changed(entryId)`; the node
 * it gets is the same one for the life of the entry, so the strip is never remounted by a redraw. `update` is the
 * page's side: it creates, updates in place and drops strips from the controller's entries, and tells the widget which
 * entry to ask about again.
 */
export class VisualsAccessories implements ChatEntryAccessories {
  private readonly strips = new Map<string, StripHost>();
  private readonly listeners = new Set<(entryId?: string) => void>();
  constructor(
    private readonly o: { chatId: string; make: () => StripHost; onVisualize(ord: number): void },
  ) {}

  render(entry: ChatEntryRef): Node | null {
    return entry.role === "assistant" ? (this.strips.get(entry.id) ?? null) : null;
  }

  subscribe(changed: (entryId?: string) => void): () => void {
    this.listeners.add(changed);
    return () => void this.listeners.delete(changed);
  }

  update(entries: readonly AccessoryEntry[]): void {
    const wanted = new Set<string>();
    for (const e of entries) {
      if (e.role !== "assistant" || e.ord === undefined || e.visuals === null) continue;
      wanted.add(e.id);
      let strip = this.strips.get(e.id);
      let changed = false;
      if (!strip) {
        strip = this.o.make();
        strip.chatId = this.o.chatId;
        strip.addEventListener("visualize", (ev) => {
          ev.stopPropagation();
          this.o.onVisualize((ev as CustomEvent<{ ord: number }>).detail.ord);
        });
        this.strips.set(e.id, strip);
        changed = true;
      }
      changed ||= !same(strip.view, e.visuals) || strip.rev !== e.visualsRev;
      strip.ord = e.ord;
      strip.rev = e.visualsRev;
      strip.view = e.visuals;
      if (changed) this.notify(e.id);
    }
    for (const id of [...this.strips.keys()])
      if (!wanted.has(id)) {
        this.strips.delete(id);
        this.notify(id);
      }
  }

  dispose(): void {
    this.strips.clear();
    this.listeners.clear();
  }

  private notify(entryId: string): void {
    for (const listener of this.listeners) listener(entryId);
  }
}
