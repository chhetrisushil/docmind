import { describe, expect, it, vi } from "vitest";
import { createServices } from "../services";
import { UploadsStore } from "../state/uploads";
import { mountWith } from "../testing/mount";
import "./dm-upload-zone";

const doc = {
  id: "7f6d1b8e-3b0a-4a56-8f2f-0a8e0f7c4d11",
  title: "T",
  filename: "a.pdf",
  mime: "application/pdf",
  sizeBytes: 1,
  status: "uploaded",
  error: null,
  stats: null,
  summary: null,
  createdAt: "2026-10-21T10:00:00.000Z",
  updatedAt: "2026-10-21T10:00:00.000Z",
};
async function mount(
  upload: (f: File, o?: { signal?: AbortSignal }) => Promise<unknown> = vi.fn(async () => ({
    document: doc,
    duplicate: false,
  })),
) {
  const uploads = new UploadsStore({ uploadDocument: upload as never }, (() => ({
    close() {},
  })) as never);
  const services = createServices({ uploads, fetch: (async () => new Response("{}")) as never });
  const el = await mountWith<HTMLElement>(services, "dm-upload-zone", { variant: "compact" });
  return { el, upload, uploads, services };
}
const q = <T extends Element>(el: Element, sel: string) => el.shadowRoot?.querySelector(sel) as T;
const file = (n: string) => new File(["x"], n);
const updated = (el: Element) =>
  (el as unknown as { updateComplete: Promise<unknown> }).updateComplete;
const drag = (
  type: string,
  files: File[],
  items?: { kind: string; webkitGetAsEntry?: () => { isDirectory: boolean } | null }[],
) => {
  const e = new Event(type, { bubbles: true, cancelable: true }) as Event & {
    dataTransfer?: unknown;
  };
  e.dataTransfer = {
    files,
    items: items ?? files.map(() => ({ kind: "file" })),
    types: ["Files"],
    dropEffect: "none",
  };
  return e;
};

describe("dm-upload-zone", () => {
  it("states what it takes and how big, and has a named browse button and a multiple-file input", async () => {
    const { el } = await mount();
    expect(el.shadowRoot?.textContent).toContain(
      "PDF, DOCX, DOC, TXT, Markdown, Org, PNG, JPG, WEBP - up to 50 MB each",
    );
    expect(q<HTMLButtonElement>(el, "button[data-browse]").textContent).toContain("browse");
    expect(q<HTMLInputElement>(el, "input[type=file]").multiple).toBe(true);
  });
  it("uploads the files chosen with the browse button and says when the batch settled", async () => {
    const { el, upload } = await mount();
    const settled = vi.fn();
    el.addEventListener("dm-uploaded", (e) => settled((e as CustomEvent).detail.results.length));
    const input = q<HTMLInputElement>(el, "input[type=file]");
    Object.defineProperty(input, "files", { value: [file("a.pdf")], configurable: true });
    input.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(settled).toHaveBeenCalledWith(1));
    expect(upload).toHaveBeenCalledTimes(1);
  });
  it("says how many files it would take while a drag is over it, uploads a drop, and ignores a folder", async () => {
    const { el, upload } = await mount();
    const zone = q<HTMLElement>(el, "[data-zone]");
    zone.dispatchEvent(drag("dragenter", [file("a.pdf"), file("b.pdf")]));
    await updated(el);
    expect(zone.textContent).toContain("Release to upload 2 files");
    zone.dispatchEvent(drag("dragleave", []));
    const drop = drag(
      "drop",
      [file("a.pdf")],
      [{ kind: "file", webkitGetAsEntry: () => ({ isDirectory: true }) }],
    );
    zone.dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(true);
    expect(upload).not.toHaveBeenCalled(); // the only item was a folder
    zone.dispatchEvent(drag("drop", [file("c.pdf")]));
    await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
  });
  it("shows a failed upload with its reason and a Dismiss button, and a running one with a named progress bar", async () => {
    const { el, uploads } = await mount();
    uploads.set({
      uploads: [
        { key: "u1", name: "big.pdf", size: 1, percent: 0, state: "failed", reason: "too_large" },
        { key: "u2", name: "b.pdf", size: 1, percent: 40, state: "uploading" },
        { key: "u3", name: "c.pdf", size: 1, percent: 0, state: "queued" },
      ],
    });
    await updated(el);
    const rows = [...(el.shadowRoot?.querySelectorAll("[data-upload]") ?? [])].map((r) =>
      r.textContent?.replace(/\s+/g, " ").trim(),
    );
    expect(rows[0]).toContain("Too large (50 MB limit).");
    expect(rows[1]).toContain("Uploading 40%");
    expect(rows[2]).toContain("Waiting");
    const bar = q<HTMLProgressElement>(el, "progress");
    expect(bar.getAttribute("aria-label")).toBe("Upload progress for b.pdf");
    expect(bar.getAttribute("role")).toBe("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("40");
    expect(bar.getAttribute("aria-valuemin")).toBe("0");
    expect(bar.getAttribute("aria-valuemax")).toBe("100");
    q<HTMLButtonElement>(el, "button[data-dismiss]").click();
    expect(uploads.get().uploads.map((u) => u.key)).toEqual(["u2", "u3"]);
  });
  it("cancels a running or waiting upload with its Cancel button", async () => {
    const signals: AbortSignal[] = [];
    const { el, uploads } = await mount(
      (_f, o) =>
        new Promise((_, reject) => {
          signals.push(o?.signal as AbortSignal);
          o?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    const input = q<HTMLInputElement>(el, "input[type=file]");
    Object.defineProperty(input, "files", { value: [file("a.pdf")], configurable: true });
    input.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    await updated(el);
    q<HTMLButtonElement>(el, "button[data-cancel]").click();
    expect(signals[0]?.aborted).toBe(true);
    await vi.waitFor(() => expect(uploads.get().uploads).toEqual([]));
  });
  it("stops its uploads when it leaves the page", async () => {
    const signals: AbortSignal[] = [];
    const { el } = await mount(
      (_f, o) =>
        new Promise((_, reject) => {
          signals.push(o?.signal as AbortSignal);
          o?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    const input = q<HTMLInputElement>(el, "input[type=file]");
    Object.defineProperty(input, "files", { value: [file("a.pdf")], configurable: true });
    input.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    el.remove();
    expect(signals[0]?.aborted).toBe(true);
  });
  it("tells the persistent live region with a fixed sentence, never the file name, when uploads fail", async () => {
    const { el, services } = await mount(
      vi.fn(async () => {
        throw new Error("x");
      }),
    );
    const input = q<HTMLInputElement>(el, "input[type=file]");
    Object.defineProperty(input, "files", {
      value: [file("secret-name.pdf"), file("other.pdf")],
      configurable: true,
    });
    input.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(services.toasts.get()).toHaveLength(1));
    expect(services.toasts.get()[0]).toMatchObject({ kind: "err", text: "2 uploads failed" });
  });
  it("says so with a fixed sentence when a batch succeeded", async () => {
    const { el, services } = await mount();
    const input = q<HTMLInputElement>(el, "input[type=file]");
    Object.defineProperty(input, "files", { value: [file("a.pdf")], configurable: true });
    input.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(services.toasts.get()).toHaveLength(1));
    expect(services.toasts.get()[0]).toMatchObject({ kind: "ok", text: "1 upload finished" });
  });
});
