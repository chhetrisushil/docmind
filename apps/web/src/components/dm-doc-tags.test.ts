import type { DocumentDto, DocumentTag, DocumentTagsResponse } from "@docmind/contracts";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/http";
import { createServices } from "../services";
import { unnamedControls } from "../testing/dom";
import { mountWith } from "../testing/mount";
import { all, q, root } from "../testing/tags";
import "./dm-doc-tags";

const DOC = "00000000-0000-4000-8000-000000000001";
const t = (n: number, name: string): DocumentTag => ({
  id: `00000000-0000-4000-8000-${String(900 + n).padStart(12, "0")}`,
  name,
});
const dto = (tags: DocumentTag[], suggestedTags: string[], summary = true): DocumentDto =>
  ({
    id: DOC,
    title: "x",
    filename: "x",
    mime: "text/plain",
    sizeBytes: 1,
    status: "ready",
    error: null,
    stats: null,
    summary: summary
      ? { tldr: "t", keyPoints: [], entities: [], topics: [], suggestedQuestions: [] }
      : null,
    tags,
    suggestedTags,
    createdAt: "2026-11-10T10:00:00.000Z",
    updatedAt: "2026-11-10T10:00:00.000Z",
  }) as DocumentDto;

type El = HTMLElement & {
  updateComplete: Promise<unknown>;
  onEvent(k: "suggested" | "failed" | "resync"): Promise<void>;
  timeoutMs: number;
};

async function setup(initial: DocumentDto, failFirst = false) {
  let failNext = failFirst;
  const state = { doc: initial };
  const respond = async (): Promise<DocumentTagsResponse> => ({
    tags: state.doc.tags,
    suggestedTags: state.doc.suggestedTags ?? [],
  });
  const api = {
    getDocument: vi.fn(async () => {
      if (failNext) {
        failNext = false;
        throw new Error("down");
      }
      return state.doc;
    }),
    listTags: vi.fn(async () => ({
      tags: [t(1, "Finance"), t(2, "Legal"), t(3, "Spare")].map((x) => ({ ...x, documents: 1 })),
    })),
    addDocumentTag: vi.fn(async (_id: string, name: string) => {
      state.doc = { ...state.doc, tags: [...state.doc.tags, { id: t(50, name).id, name }] };
      return respond();
    }),
    removeDocumentTag: vi.fn(async (_id: string, tagId: string) => {
      state.doc = { ...state.doc, tags: state.doc.tags.filter((x) => x.id !== tagId) };
      return respond();
    }),
    acceptTagSuggestion: vi.fn(async (_id: string, name: string) => {
      state.doc = {
        ...state.doc,
        tags: [...state.doc.tags, { id: t(60, name).id, name }],
        suggestedTags: (state.doc.suggestedTags ?? []).filter((n) => n !== name),
      };
      return respond();
    }),
    dismissTagSuggestion: vi.fn(async (_id: string, name: string) => {
      state.doc = {
        ...state.doc,
        suggestedTags: (state.doc.suggestedTags ?? []).filter((n) => n !== name),
      };
      return respond();
    }),
    refreshTagSuggestions: vi.fn(async () => {}),
  };
  const services = createServices({ api: api as never });
  const el = await mountWith<El>(services, "dm-doc-tags", { documentId: DOC });
  await vi.waitFor(() => expect(api.getDocument).toHaveBeenCalled());
  await Promise.resolve();
  await el.updateComplete;
  return { el, api, state };
}
async function setupFailing() {
  const f = await setup(dto([], []), true);
  return f;
}
const settle = async (el: El) => {
  await Promise.resolve();
  await el.updateComplete;
};

describe("dm-doc-tags", () => {
  it("draws the document's tags as chips with a named remove button, and removes one", async () => {
    const s = await setup(dto([t(1, "Finance"), t(2, "Legal")], []));
    await vi.waitFor(() =>
      expect(all(s.el, "[data-tags] .chip").map((c) => c.firstChild?.textContent?.trim())).toEqual([
        "Finance",
        "Legal",
      ]),
    );
    expect(q(s.el, "[role=group][aria-label=Tags]")).not.toBeNull();
    q<HTMLButtonElement>(s.el, "button[aria-label='Remove tag Finance']").click();
    await vi.waitFor(() => expect(s.api.removeDocumentTag).toHaveBeenCalledWith(DOC, t(1, "").id));
    await vi.waitFor(() => expect(all(s.el, "[data-tags] .chip")).toHaveLength(1));
  });

  it("adds the typed name on Enter (trimmed), clears the box, and ignores an empty box", async () => {
    const s = await setup(dto([], []));
    const input = q<HTMLInputElement>(s.el, "input[aria-label='Add a tag']");
    input.value = "   ";
    input.dispatchEvent(new Event("input"));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(s.api.addDocumentTag).not.toHaveBeenCalled();
    input.value = "  Q3 plan ";
    input.dispatchEvent(new Event("input"));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await vi.waitFor(() => expect(s.api.addDocumentTag).toHaveBeenCalledWith(DOC, "Q3 plan"));
    await vi.waitFor(() =>
      expect(all(s.el, "[data-tags] .chip").map((c) => c.firstChild?.textContent?.trim())).toEqual([
        "Q3 plan",
      ]),
    );
    expect(q<HTMLInputElement>(s.el, "input[aria-label='Add a tag']").value).toBe("");
  });

  it("says why when the document already holds 20 tags", async () => {
    const s = await setup(dto([], []));
    s.api.addDocumentTag.mockRejectedValueOnce(new ApiError(409, "tag_limit"));
    const input = q<HTMLInputElement>(s.el, "input[aria-label='Add a tag']");
    input.value = "one more";
    input.dispatchEvent(new Event("input"));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await vi.waitFor(() =>
      expect(q(s.el, "[role=alert]")?.textContent).toContain("at most 20 tags"),
    );
  });

  it("offers the user's other tags as autocomplete, loaded once, without the ones the document has", async () => {
    const s = await setup(dto([t(1, "Finance")], []));
    const input = q<HTMLInputElement>(s.el, "input[aria-label='Add a tag']");
    input.dispatchEvent(new Event("focus"));
    input.dispatchEvent(new Event("focus"));
    await vi.waitFor(() => expect(s.api.listTags).toHaveBeenCalledTimes(1));
    await s.el.updateComplete;
    expect(all<HTMLOptionElement>(s.el, "datalist option").map((o) => o.value)).toEqual([
      "Legal",
      "Spare",
    ]);
    expect(input.getAttribute("list")).toBe(q(s.el, "datalist").id);
  });

  it("shows each suggestion with Accept and Dismiss, and accepting moves it to the tags", async () => {
    const s = await setup(dto([], ["Legal", "Misc"]));
    await vi.waitFor(() => expect(all(s.el, "[data-suggested] .chip")).toHaveLength(2));
    expect(q(s.el, "[role=group][aria-label='Suggested tags']")).not.toBeNull();
    q<HTMLButtonElement>(s.el, "button[aria-label='Accept suggested tag Legal']").click();
    await vi.waitFor(() => expect(s.api.acceptTagSuggestion).toHaveBeenCalledWith(DOC, "Legal"));
    await vi.waitFor(() =>
      expect(all(s.el, "[data-tags] .chip").map((c) => c.firstChild?.textContent?.trim())).toEqual([
        "Legal",
      ]),
    );
    q<HTMLButtonElement>(s.el, "button[aria-label='Dismiss suggested tag Misc']").click();
    await vi.waitFor(() => expect(s.api.dismissTagSuggestion).toHaveBeenCalledWith(DOC, "Misc"));
    await vi.waitFor(() => expect(all(s.el, "[data-suggested] .chip")).toHaveLength(0));
  });

  it("disables Suggest tags with the reason when the document has no summary", async () => {
    const s = await setup(dto([], [], false));
    const button = q<HTMLButtonElement>(s.el, "[data-suggest]");
    expect(button.disabled).toBe(true);
    const reason = q(s.el, "[data-reason]");
    expect(reason.textContent).toContain("summary");
    expect(button.getAttribute("aria-describedby")).toBe(reason.id);
  });

  it("shows a busy state while the flow runs, and ends it on the suggested event with fresh suggestions", async () => {
    const s = await setup(dto([], []));
    q<HTMLButtonElement>(s.el, "[data-suggest]").click();
    await vi.waitFor(() => expect(s.api.refreshTagSuggestions).toHaveBeenCalledWith(DOC));
    await settle(s.el);
    const busy = q<HTMLButtonElement>(s.el, "[data-suggest]");
    expect([busy.disabled, busy.getAttribute("aria-busy"), busy.textContent?.trim()]).toEqual([
      true,
      "true",
      "Suggesting…",
    ]);
    s.state.doc = dto([], ["Fresh"]);
    await s.el.onEvent("suggested");
    await settle(s.el);
    expect(q<HTMLButtonElement>(s.el, "[data-suggest]").getAttribute("aria-busy")).not.toBe("true");
    expect(all(s.el, "[data-suggested] .chip")).toHaveLength(1);
  });

  it("a failed run says Couldn't suggest tags with Retry, which starts it again", async () => {
    const s = await setup(dto([], []));
    q<HTMLButtonElement>(s.el, "[data-suggest]").click();
    await vi.waitFor(() => expect(s.api.refreshTagSuggestions).toHaveBeenCalledTimes(1));
    await s.el.onEvent("failed");
    await settle(s.el);
    expect(q(s.el, "[data-suggest-failed]")?.textContent).toContain("Couldn't suggest tags");
    q<HTMLButtonElement>(s.el, "[data-suggest-retry]").click();
    await vi.waitFor(() => expect(s.api.refreshTagSuggestions).toHaveBeenCalledTimes(2));
    await settle(s.el);
    expect(q(s.el, "[data-suggest-failed]")).toBeNull();
  });

  it("keeps waiting when a run is already going, and gives fixed notes for the other refusals", async () => {
    const s = await setup(dto([], []));
    s.api.refreshTagSuggestions.mockRejectedValueOnce(new ApiError(409, "suggest_running"));
    q<HTMLButtonElement>(s.el, "[data-suggest]").click();
    await vi.waitFor(() => expect(s.api.refreshTagSuggestions).toHaveBeenCalled());
    await settle(s.el);
    expect(q<HTMLButtonElement>(s.el, "[data-suggest]").getAttribute("aria-busy")).toBe("true");
    await s.el.onEvent("suggested");
    await settle(s.el);
    s.api.refreshTagSuggestions.mockRejectedValueOnce(new ApiError(429, "too_many_requests"));
    q<HTMLButtonElement>(s.el, "[data-suggest]").click();
    await vi.waitFor(() =>
      expect(q(s.el, "[data-suggest-note]")?.textContent).toContain("Too many"),
    );
    expect(q<HTMLButtonElement>(s.el, "[data-suggest]").disabled).toBe(false);
  });

  it("falls back to reading the state when no event arrives within the timeout", async () => {
    const s = await setup(dto([], []));
    s.el.timeoutMs = 10;
    q<HTMLButtonElement>(s.el, "[data-suggest]").click();
    await vi.waitFor(() => expect(s.api.refreshTagSuggestions).toHaveBeenCalled());
    const reads = s.api.getDocument.mock.calls.length;
    await vi.waitFor(() => expect(s.api.getDocument.mock.calls.length).toBeGreaterThan(reads));
    await settle(s.el);
    expect(q<HTMLButtonElement>(s.el, "[data-suggest]").getAttribute("aria-busy")).not.toBe("true");
  });

  it("a resync reloads, and no control lacks an accessible name", async () => {
    const s = await setup(dto([t(1, "Finance")], ["Legal"]));
    const reads = s.api.getDocument.mock.calls.length;
    await s.el.onEvent("resync");
    expect(s.api.getDocument.mock.calls.length).toBe(reads + 1);
    await settle(s.el);
    expect(unnamedControls(s.el)).toEqual([]);
  });

  it("before the first read shows no reason, and a failed read shows an error with Retry, not 'no summary'", async () => {
    const failing = await setupFailing();
    await vi.waitFor(() => expect(q(failing.el, "[data-load-failed]")).not.toBeNull());
    expect(q(failing.el, "[data-reason]")).toBeNull();
    expect(q(failing.el, "[data-suggest]").getAttribute("aria-describedby")).toBeNull();
    q<HTMLButtonElement>(failing.el, "[data-load-retry]").click();
    await vi.waitFor(() => expect(q(failing.el, "[data-load-failed]")).toBeNull());
    expect(q<HTMLButtonElement>(failing.el, "[data-suggest]").disabled).toBe(false);
  });

  it("a document change resets busy, draft, notes and suggestions, and reads the new document", async () => {
    const s = await setup(dto([t(1, "Finance")], ["Legal"]));
    q<HTMLButtonElement>(s.el, "[data-suggest]").click();
    const input = q<HTMLInputElement>(s.el, "input[aria-label='Add a tag']");
    input.value = "typed";
    input.dispatchEvent(new Event("input"));
    await settle(s.el);
    s.state.doc = { ...dto([], []), id: "00000000-0000-4000-8000-000000000002" };
    (s.el as unknown as { documentId: string }).documentId = "00000000-0000-4000-8000-000000000002";
    await vi.waitFor(() =>
      expect(s.api.getDocument).toHaveBeenLastCalledWith("00000000-0000-4000-8000-000000000002"),
    );
    await vi.waitFor(() => expect(all(s.el, "[data-tags] .chip")).toHaveLength(0));
    expect(all(s.el, "[data-suggested] .chip")).toHaveLength(0);
    expect(q<HTMLButtonElement>(s.el, "[data-suggest]").getAttribute("aria-busy")).not.toBe("true");
    expect(q<HTMLInputElement>(s.el, "input[aria-label='Add a tag']").value).toBe("");
  });

  it("keeps the typed name when an add fails, and shows the error", async () => {
    const s = await setup(dto([], []));
    s.api.addDocumentTag.mockRejectedValueOnce(new ApiError(409, "tag_limit"));
    const input = q<HTMLInputElement>(s.el, "input[aria-label='Add a tag']");
    input.value = "one more";
    input.dispatchEvent(new Event("input"));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await vi.waitFor(() => expect(q(s.el, "[role=alert]")).not.toBeNull());
    await settle(s.el);
    expect(q<HTMLInputElement>(s.el, "input[aria-label='Add a tag']").value).toBe("one more");
  });

  it("a 404 on remove or accept reloads the row; the autocomplete reloads after a tag is added", async () => {
    const s = await setup(dto([t(1, "Finance")], ["Legal"]));
    s.api.removeDocumentTag.mockRejectedValueOnce(new ApiError(404, "not_found"));
    s.state.doc = dto([], ["Legal"]);
    q<HTMLButtonElement>(s.el, "button[aria-label='Remove tag Finance']").click();
    await vi.waitFor(() => expect(all(s.el, "[data-tags] .chip")).toHaveLength(0));
    expect(q(s.el, "[role=alert]")).not.toBeNull();
    s.api.acceptTagSuggestion.mockRejectedValueOnce(new ApiError(404, "not_found"));
    s.state.doc = dto([], []);
    q<HTMLButtonElement>(s.el, "button[aria-label='Accept suggested tag Legal']").click();
    await vi.waitFor(() => expect(all(s.el, "[data-suggested] .chip")).toHaveLength(0));
    const input = q<HTMLInputElement>(s.el, "input[aria-label='Add a tag']");
    input.dispatchEvent(new Event("focus"));
    await vi.waitFor(() => expect(s.api.listTags).toHaveBeenCalledTimes(1));
    input.value = "New";
    input.dispatchEvent(new Event("input"));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await vi.waitFor(() => expect(s.api.addDocumentTag).toHaveBeenCalled());
    await settle(s.el);
    input.dispatchEvent(new Event("focus"));
    await vi.waitFor(() => expect(s.api.listTags).toHaveBeenCalledTimes(2));
  });

  it("announces actions in a status region, and a double press makes one request", async () => {
    const s = await setup(dto([], []));
    const input = q<HTMLInputElement>(s.el, "input[aria-label='Add a tag']");
    input.value = "Alpha";
    input.dispatchEvent(new Event("input"));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await vi.waitFor(() =>
      expect(q(s.el, "[data-announce]").textContent).toContain("Added tag Alpha"),
    );
    const b = q<HTMLButtonElement>(s.el, "[data-suggest]");
    b.click();
    b.click();
    await settle(s.el);
    expect(s.api.refreshTagSuggestions).toHaveBeenCalledTimes(1);
  });

  it("renders a tag name containing markup as text", async () => {
    const s = await setup(dto([t(1, "<img src=x onerror=alert(1)>")], ["<b>hi</b>"]));
    await vi.waitFor(() => expect(all(s.el, "[data-tags] .chip")).toHaveLength(1));
    expect(root(s.el).querySelector("img, b")).toBeNull();
    expect(q(s.el, "[data-tags] [data-name]").textContent).toBe("<img src=x onerror=alert(1)>");
  });
});
