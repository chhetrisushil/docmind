import { describe, expect, it } from "vitest";
import { promptDialog } from "./prompt";

const field = () => document.querySelector("dm-dialog input") as HTMLInputElement;
const btn = (t: string) =>
  [...document.querySelectorAll("dm-dialog button")].find(
    (b) => b.textContent === t,
  ) as HTMLButtonElement;
const shown = () => document.querySelector("dm-dialog input") !== null;

describe("promptDialog", () => {
  it("offers the current value, labelled, and resolves the new one on Save", async () => {
    const p = promptDialog("Rename chat", "Title", "Old", "Save");
    expect(field().value).toBe("Old");
    expect(field().getAttribute("aria-label")).toBe("Title");
    field().value = "  New title ";
    btn("Save").click();
    expect(await p).toBe("New title");
    expect(document.querySelector("dm-dialog")).toBeNull();
  });
  it("resolves undefined for Cancel, Escape, an empty value and an unchanged one", async () => {
    for (const act of [
      () => btn("Cancel").click(),
      () => document.querySelector("dm-dialog")?.dispatchEvent(new CustomEvent("dm-close")),
      () => {
        field().value = "   ";
        btn("Save").click();
      },
      () => btn("Save").click(),
    ]) {
      const p = promptDialog("Rename chat", "Title", "Old", "Save");
      act();
      expect(await p).toBeUndefined();
      expect(document.querySelector("dm-dialog")).toBeNull();
    }
  });
  it("Enter in the field confirms", async () => {
    const p = promptDialog("Rename chat", "Title", "Old", "Save");
    field().value = "Via enter";
    field().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(await p).toBe("Via enter");
  });
  it("caps the field at 200 characters", async () => {
    const p = promptDialog("Rename chat", "Title", "Old", "Save");
    expect(field().maxLength).toBe(200);
    btn("Cancel").click();
    await p;
  });
  it("answers undefined and removes itself when the signal aborts, or is already aborted", async () => {
    const ac = new AbortController();
    const p = promptDialog("Rename chat", "Title", "Old", "Save", ac.signal);
    expect(shown()).toBe(true);
    ac.abort();
    expect(await p).toBeUndefined();
    expect(shown()).toBe(false);
    expect(await promptDialog("Rename chat", "Title", "Old", "Save", ac.signal)).toBeUndefined();
    expect(shown()).toBe(false);
  });
});
