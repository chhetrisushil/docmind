import { describe, expect, it } from "vitest";
import { ToastStore } from "./toasts";

describe("ToastStore", () => {
  it("adds toasts with increasing ids and dismisses one by id", () => {
    const toasts = new ToastStore();
    const a = toasts.push({ kind: "ok", text: "Saved" });
    const b = toasts.push({
      kind: "err",
      text: "Failed",
      action: { label: "Retry", run: () => {} },
    });
    expect(b).toBeGreaterThan(a);
    expect(toasts.get().map((t) => t.text)).toEqual(["Saved", "Failed"]);
    toasts.dismiss(a);
    expect(toasts.get().map((t) => t.id)).toEqual([b]);
    toasts.dismiss(999);
    expect(toasts.get().length).toBe(1);
  });
  it("keeps at most five, dropping the oldest", () => {
    const toasts = new ToastStore();
    for (let i = 0; i < 7; i++) toasts.push({ kind: "ok", text: `t${i}` });
    expect(toasts.get().map((t) => t.text)).toEqual(["t2", "t3", "t4", "t5", "t6"]);
  });
});
