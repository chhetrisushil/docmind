import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/http";
import { createServices } from "../services";
import { mountWith } from "../testing/mount";
import "./dm-account-deleted";

const RECEIPT = "B".repeat(43);
const q = <T extends Element>(el: Element, sel: string) => el.shadowRoot?.querySelector(sel) as T;

function setup(receipt: string | undefined, erasureStatus: () => Promise<unknown>) {
  const api = { erasureStatus: vi.fn(erasureStatus) } as never;
  const services = createServices({ api, fetch: (async () => new Response("{}")) as never });
  if (receipt) services.receipt.set(receipt);
  return { services, api };
}

describe("dm-account-deleted", () => {
  it("shows the receipt once with a copy button and the statement that it is not kept", async () => {
    const { services } = setup(RECEIPT, async () => ({ state: "pending" }));
    const el = await mountWith<HTMLElement>(services, "dm-account-deleted");
    expect(q(el, "[data-receipt]").textContent).toBe(RECEIPT);
    expect(el.shadowRoot?.textContent).toContain("shown once");
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    q<HTMLButtonElement>(el, "button[data-copy]").click();
    expect(writeText).toHaveBeenCalledWith(RECEIPT);
  });

  it("checks the state with the receipt and says in words whether the erasure is done", async () => {
    const answers = [{ state: "pending" }, { state: "done" }];
    const { services, api } = setup(RECEIPT, async () => answers.shift());
    const el = await mountWith<HTMLElement>(services, "dm-account-deleted");
    q<HTMLButtonElement>(el, "button[data-check]").click();
    await vi.waitFor(() => expect(q(el, "[data-state]").textContent).toContain("In progress"));
    q<HTMLButtonElement>(el, "button[data-check]").click();
    await vi.waitFor(() => expect(q(el, "[data-state]").textContent).toContain("Done"));
    expect(
      (api as never as { erasureStatus: ReturnType<typeof vi.fn> }).erasureStatus,
    ).toHaveBeenCalledWith(RECEIPT);
  });

  it("handles an unknown receipt and a dead connection without showing server text", async () => {
    const { services } = setup(RECEIPT, async () => {
      throw new ApiError(404, "not_found");
    });
    const el = await mountWith<HTMLElement>(services, "dm-account-deleted");
    q<HTMLButtonElement>(el, "button[data-check]").click();
    await vi.waitFor(() =>
      expect(q(el, "[data-state]").textContent).toContain("No deletion matches this receipt."),
    );
    const down = setup(RECEIPT, async () => {
      throw new ApiError(0, "network");
    });
    const el2 = await mountWith<HTMLElement>(down.services, "dm-account-deleted");
    q<HTMLButtonElement>(el2, "button[data-check]").click();
    await vi.waitFor(() =>
      expect(q(el2, "[data-state]").textContent).toContain("Could not reach the server."),
    );
  });

  it("without a receipt (a reload) says the page cannot show it, and offers a way back", async () => {
    const { services } = setup(undefined, async () => ({ state: "done" }));
    const el = await mountWith<HTMLElement>(services, "dm-account-deleted");
    expect(q(el, "[data-receipt]")).toBeNull();
    expect(el.shadowRoot?.textContent).toContain("no longer on this page");
    expect(q<HTMLAnchorElement>(el, "a[href='/sign-up']")).not.toBeNull();
  });
});
