import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/http";
import { createServices } from "../services";
import { fakeUi } from "../testing/fakeUi";
import { mountWith } from "../testing/mount";
import "./dm-view";

const settle = (el: Element) =>
  (el as unknown as { updateComplete: Promise<unknown> }).updateComplete;
const q = <T extends Element>(el: Element, sel: string) => el.shadowRoot?.querySelector(sel) as T;

describe("dm-view", () => {
  it("shows a loading line, then the view, and says it is ready", async () => {
    const ui = fakeUi();
    const services = createServices({ api: ui.api as never });
    const ready = vi.fn();
    const mounted = await mountWith<HTMLElement>(services, "dm-view", { name: "library-empty" });
    mounted.addEventListener("view-ready", ready); // the view is fetched asynchronously, so this is in time
    await vi.waitFor(() => expect(q(mounted, "#host lu-note")).not.toBeNull());
    expect(q(mounted, "#host lu-note").shadowRoot?.textContent).toContain("No documents yet");
    expect(q(mounted, "[data-loading]")).toBeNull();
    expect(ready).toHaveBeenCalledTimes(1);
  });

  it("shows a fixed sentence and a Try again button when the view cannot be fetched, and recovers", async () => {
    const ui = fakeUi();
    let fail = true;
    const api = {
      ...ui.api,
      uiView: vi.fn(async (name: never) => {
        if (fail) throw new ApiError(0, "network");
        return ui.api.uiView(name);
      }),
    };
    const services = createServices({ api: api as never });
    const el = await mountWith<HTMLElement>(services, "dm-view", { name: "library-empty" });
    await vi.waitFor(() => expect(q(el, "[role=alert]")).not.toBeNull());
    expect(q(el, "[role=alert]").textContent).toContain("could not be loaded");
    await new Promise((r) => setTimeout(r, 30));
    expect(api.uiView).toHaveBeenCalledTimes(1); // a failed fetch does not retry by itself
    fail = false;
    q<HTMLButtonElement>(el, "button[data-retry]").click();
    await vi.waitFor(() => expect(q(el, "#host lu-note")).not.toBeNull());
  });

  it("swaps the experience when the name changes, and disposes the old one", async () => {
    const ui = fakeUi();
    const services = createServices({ api: ui.api as never });
    const el = await mountWith<HTMLElement & { name: string; session?: { name: string } }>(
      services,
      "dm-view",
      { name: "library-empty" },
    );
    await vi.waitFor(() => expect(el.session?.name).toBe("library-empty"));
    el.name = "sessions";
    await settle(el);
    await vi.waitFor(() => expect(el.session?.name).toBe("sessions"));
    expect(q(el, "#host lu-note")).toBeNull();
  });
});
