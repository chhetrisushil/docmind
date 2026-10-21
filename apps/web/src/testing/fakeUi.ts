import { createRequire } from "node:module";
import type { UiViewResponse, ViewName } from "@docmind/contracts";
import type { UiReaders } from "@docmind/experiences";
import type { Api } from "../api/client";

// `@docmind/experiences` is a Node (CommonJS) package: tests load it the way Node does, never through the browser bundler.
type Experiences = typeof import("@docmind/experiences");
const experiences = createRequire(import.meta.url)("@docmind/experiences") as Experiences;

export const emptyReaders = (): UiReaders => ({
  documents: async () => ({ items: [], truncated: false }),
  document: async () => null,
  content: async () => null,
  chats: async () => [],
});

/** The server's UI plane in-process: the real compiled views and the real `hydrate`, over the readers a test gives. */
export function fakeUi(readers: UiReaders = emptyReaders()) {
  const views = experiences.createViews({
    placeholderKey: "k".repeat(32),
    revisionKey: "r".repeat(32),
  });
  const calls = { views: [] as ViewName[], hydrate: [] as { view: ViewName; handles: string[] }[] };
  const api: Pick<Api, "uiView" | "uiHydrate"> = {
    async uiView(name) {
      calls.views.push(name);
      return structuredClone(views.payload(name, "web")) as unknown as UiViewResponse;
    },
    async uiHydrate(view, requests) {
      calls.hydrate.push({ view, handles: requests.map((r) => r.handle) });
      return views.hydrate(view, requests, readers, "user-1");
    },
  };
  return { api, views, calls };
}
