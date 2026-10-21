import { describe, expect, it } from "vitest";
import { confirmDialog } from "./confirm";

const buttons = () => [...document.querySelectorAll("dm-dialog button")] as HTMLButtonElement[];
describe("confirmDialog", () => {
  it("resolves true on the confirm button and removes itself", async () => {
    const p = confirmDialog("Delete this document?", "It cannot be undone.", "Delete", true);
    await new Promise((r) => setTimeout(r, 0));
    expect(document.querySelector("dm-dialog")?.getAttribute("heading")).toBe(
      "Delete this document?",
    );
    buttons()
      .find((b) => b.textContent === "Delete")
      ?.click();
    expect(await p).toBe(true);
    expect(document.querySelector("dm-dialog")).toBeNull();
  });
  it("resolves false on Cancel and on dm-close (Escape)", async () => {
    const a = confirmDialog("Sure?", "x", "Yes");
    await new Promise((r) => setTimeout(r, 0));
    buttons()
      .find((b) => b.textContent === "Cancel")
      ?.click();
    expect(await a).toBe(false);
    const b = confirmDialog("Sure?", "x", "Yes");
    await new Promise((r) => setTimeout(r, 0));
    document.querySelector("dm-dialog")?.dispatchEvent(new CustomEvent("dm-close"));
    expect(await b).toBe(false);
    expect(document.querySelector("dm-dialog")).toBeNull();
  });
  it("resolves false and goes away when its signal aborts", async () => {
    const ac = new AbortController();
    const p = confirmDialog("Sure?", "x", "Yes", false, ac.signal);
    await new Promise((r) => setTimeout(r, 0));
    ac.abort();
    expect(await p).toBe(false);
    expect(document.querySelector("dm-dialog")).toBeNull();
  });
});
