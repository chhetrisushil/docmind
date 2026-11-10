import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/http";
import { createServices } from "../services";
import { unnamedControls } from "../testing/dom";
import { mountWith } from "../testing/mount";
import { q, root, tag } from "../testing/tags";
import "./dm-tag-manage";

type El = HTMLElement & { updateComplete: Promise<unknown> };

async function setup(tags = [tag(1, "Finance", 3), tag(2, "Legal", 1), tag(3, "Unused", 0)]) {
  const api = {
    renameTag: vi.fn(async (id: string, name: string) => ({ id, name })),
    deleteTag: vi.fn(async () => {}),
  };
  const services = createServices({ api: api as never });
  const el = await mountWith<El>(services, "dm-tag-manage", { tags });
  const changed: number[] = [];
  el.addEventListener("tags-changed", () => changed.push(1));
  return { el, api, changed };
}

describe("dm-tag-manage", () => {
  it("lists every tag with its document count and a named Rename and Delete", async () => {
    const t = await setup();
    expect(
      [...root(t.el).querySelectorAll("li")].map(
        (li) => li.textContent?.replace(/\s+/g, " ").trim().split(" Rename")[0],
      ),
    ).toEqual(["Finance 3 documents", "Legal 1 document", "Unused 0 documents"]);
    expect(unnamedControls(t.el)).toEqual([]);
    expect(q<HTMLButtonElement>(t.el, "button[aria-label='Rename Finance']")).not.toBeNull();
    expect(q<HTMLButtonElement>(t.el, "button[aria-label='Delete Finance']")).not.toBeNull();
  });

  it("renames inline: edit, Enter or Save, then tags-changed", async () => {
    const t = await setup();
    q<HTMLButtonElement>(t.el, "button[aria-label='Rename Finance']").click();
    await t.el.updateComplete;
    const input = q<HTMLInputElement>(t.el, "input[aria-label='New name for Finance']");
    expect(input.value).toBe("Finance");
    input.value = "  Money ";
    input.dispatchEvent(new Event("input"));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await vi.waitFor(() => expect(t.api.renameTag).toHaveBeenCalledWith(tag(1, "", 0).id, "Money"));
    await vi.waitFor(() => expect(t.changed).toHaveLength(1));
  });

  it("limits a new name to 40 characters, not 40 UTF-16 units", async () => {
    const t = await setup();
    q<HTMLButtonElement>(t.el, "button[aria-label='Rename Finance']").click();
    await t.el.updateComplete;
    const input = q<HTMLInputElement>(t.el, "input[aria-label='New name for Finance']");
    expect(input.hasAttribute("maxlength")).toBe(false);
    input.value = "\u{1F600}".repeat(45);
    input.dispatchEvent(new Event("input"));
    await t.el.updateComplete;
    expect([...input.value]).toHaveLength(40);
  });

  it("Escape cancels the edit without calling the server", async () => {
    const t = await setup();
    q<HTMLButtonElement>(t.el, "button[aria-label='Rename Legal']").click();
    await t.el.updateComplete;
    q<HTMLInputElement>(t.el, "input[aria-label='New name for Legal']").dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape" }),
    );
    await t.el.updateComplete;
    expect(q(t.el, "input")).toBeNull();
    expect(t.api.renameTag).not.toHaveBeenCalled();
  });

  it("shows a fixed sentence for a name that is taken, and keeps editing", async () => {
    const t = await setup();
    t.api.renameTag.mockRejectedValueOnce(new ApiError(409, "tag_exists"));
    q<HTMLButtonElement>(t.el, "button[aria-label='Rename Legal']").click();
    await t.el.updateComplete;
    const input = q<HTMLInputElement>(t.el, "input[aria-label='New name for Legal']");
    input.value = "Finance";
    input.dispatchEvent(new Event("input"));
    q<HTMLButtonElement>(t.el, "button[data-save]").click();
    await vi.waitFor(() =>
      expect(q(t.el, "[role=alert]")?.textContent).toContain(
        "A tag with that name already exists.",
      ),
    );
    expect(q(t.el, "input")).not.toBeNull();
    expect(t.changed).toHaveLength(0);
  });

  it.each(["cancel", "escape"])(
    "clears a rename error when the edit is left with %s",
    async (how) => {
      const t = await setup();
      t.api.renameTag.mockRejectedValueOnce(new ApiError(409, "tag_exists"));
      q<HTMLButtonElement>(t.el, "button[aria-label='Rename Legal']").click();
      await t.el.updateComplete;
      const input = q<HTMLInputElement>(t.el, "input[aria-label='New name for Legal']");
      input.value = "Finance";
      input.dispatchEvent(new Event("input"));
      q<HTMLButtonElement>(t.el, "button[data-save]").click();
      await vi.waitFor(() => expect(q(t.el, "[role=alert]")).not.toBeNull());
      if (how === "cancel") q<HTMLButtonElement>(t.el, "button[data-cancel]").click();
      else input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      await t.el.updateComplete;
      expect(q(t.el, "input")).toBeNull();
      expect(q(t.el, "[role=alert]")).toBeNull();
    },
  );

  it("asks before deleting, naming how many documents use the tag, and deletes on yes", async () => {
    const t = await setup();
    q<HTMLButtonElement>(t.el, "button[aria-label='Delete Finance']").click();
    await vi.waitFor(() => expect(document.querySelector("dm-dialog")).not.toBeNull());
    expect(document.querySelector("dm-dialog")?.textContent).toContain("Finance");
    expect(document.querySelector("dm-dialog")?.textContent).toContain("3 documents");
    [...document.querySelectorAll("dm-dialog button")]
      .find((b) => b.textContent === "Delete")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await vi.waitFor(() => expect(t.api.deleteTag).toHaveBeenCalledWith(tag(1, "", 0).id));
    await vi.waitFor(() => expect(t.changed).toHaveLength(1));
  });

  it("does not delete on Cancel, and says so plainly for a tag no document uses", async () => {
    const t = await setup();
    q<HTMLButtonElement>(t.el, "button[aria-label='Delete Unused']").click();
    await vi.waitFor(() => expect(document.querySelector("dm-dialog")).not.toBeNull());
    expect(document.querySelector("dm-dialog")?.textContent).toContain("no document");
    [...document.querySelectorAll("dm-dialog button")]
      .find((b) => b.textContent === "Cancel")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await vi.waitFor(() => expect(document.querySelector("dm-dialog")).toBeNull());
    expect(t.api.deleteTag).not.toHaveBeenCalled();
  });

  it("reloads the list when the tag was already deleted elsewhere (404)", async () => {
    const t = await setup();
    t.api.deleteTag.mockRejectedValueOnce(new ApiError(404, "not_found"));
    q<HTMLButtonElement>(t.el, "button[aria-label='Delete Legal']").click();
    await vi.waitFor(() => expect(document.querySelector("dm-dialog")).not.toBeNull());
    [...document.querySelectorAll("dm-dialog button")]
      .find((b) => b.textContent === "Delete")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await vi.waitFor(() => expect(t.changed).toHaveLength(1));
    expect(q(t.el, "[role=alert]")).toBeNull();
  });
});
