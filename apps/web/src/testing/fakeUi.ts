import { createRequire } from "node:module";
import type { UiViewResponse, ViewName } from "@docmind/contracts";
import type { UiReaders } from "@docmind/experiences";
import type { Api, ViewSource } from "../api/client";

// `@docmind/experiences` is a Node (CommonJS) package: tests load it the way Node does, never through the browser bundler.
type Experiences = typeof import("@docmind/experiences");
const experiences = createRequire(import.meta.url)("@docmind/experiences") as Experiences;

export const emptyReaders = (): UiReaders => ({
  documents: async () => ({ items: [], truncated: false }),
  document: async () => null,
  content: async () => null,
  source: async () => null,
  chats: async () => [],
  visualFacts: async () => null,
  turnFacts: async () => null,
});

/** The server's UI plane in-process: the real compiled views and the real `hydrate`, over the readers a test gives. */
export function fakeUi(readers: UiReaders = emptyReaders()) {
  const views = experiences.createViews({
    placeholderKey: "k".repeat(32),
    revisionKey: "r".repeat(32),
  });
  const calls = {
    views: [] as ViewName[],
    documents: [] as string[],
    hydrate: [] as { source: ViewSource; handles: string[] }[],
    turns: [] as [string, number][],
  };
  const api: Pick<Api, "uiView" | "uiDocumentDetail" | "uiTurnVisuals" | "uiHydrate"> = {
    async uiView(name) {
      calls.views.push(name);
      return structuredClone(views.payload(name, "web")) as unknown as UiViewResponse;
    },
    async uiDocumentDetail(id) {
      calls.documents.push(id);
      return structuredClone(views.documentPayload(id, null, "web")) as unknown as UiViewResponse;
    },
    uiTurnVisuals(chatId, ord) {
      calls.turns.push([chatId, ord]);
      return new Promise<never>(() => {}); // a turn view that never arrives: the page tests need the strip, not a preview
    },
    async uiHydrate(source, requests) {
      calls.hydrate.push({ source, handles: requests.map((r) => r.handle) });
      if ("turn" in source) throw new Error("the fake UI plane serves no turn hydrate");
      return "view" in source
        ? views.hydrate(source.view, requests, readers, "user-1")
        : views.hydrateExperience(
            experiences.detailWithVisuals(null, source.document),
            requests,
            readers,
            "user-1",
          );
    },
  };
  return { api, views, calls };
}
