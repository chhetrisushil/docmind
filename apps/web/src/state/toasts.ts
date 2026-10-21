import { Store } from "./store";

export interface Toast {
  id: number;
  kind: "ok" | "err";
  text: string;
  action?: { label: string; run(): void };
}
const MAX = 5;

export class ToastStore extends Store<Toast[]> {
  private seq = 0;
  constructor() {
    super([]);
  }
  push(t: Omit<Toast, "id">): number {
    const id = ++this.seq;
    this.update((all) => [...all, { ...t, id }].slice(-MAX));
    return id;
  }
  dismiss(id: number): void {
    this.update((all) => (all.some((t) => t.id === id) ? all.filter((t) => t.id !== id) : all));
  }
}
