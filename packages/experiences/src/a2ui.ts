/** The summary tab: the tl;dr, key points, topics and entities, suggested questions as buttons. Data: `SummaryData` (186c). */
export const SUMMARY_VIEW = {
  catalogId: "docmind.v1",
  nodes: [
    { id: "root", component: "Column", children: ["tldr", "kp-h", "kp", "meta", "qs-h", "qs"] },
    { id: "tldr", component: "Text", text: { path: "/tldr" } },
    { id: "kp-h", component: "Text", text: "Key points" },
    { id: "kp", component: "List", children: { path: "/keyPoints", componentId: "kp-item" } },
    { id: "kp-item", component: "Text", text: { path: "/text" } },
    { id: "meta", component: "Text", text: { path: "/meta" } },
    { id: "qs-h", component: "Text", text: "Suggested questions" },
    { id: "qs", component: "List", children: { path: "/questions", componentId: "q-item" } },
    { id: "q-item", component: "Button", label: { path: "/label" }, action: "ask-question" },
  ],
} as const;

/** The content tab: passages with where they sit, and a button for more. Data: `ContentData` (186c). */
export const CONTENT_VIEW = {
  catalogId: "docmind.v1",
  nodes: [
    { id: "root", component: "Column", children: ["note", "list", "more"] },
    { id: "note", component: "Text", text: { path: "/note" } },
    { id: "list", component: "List", children: { path: "/passages", componentId: "p-item" } },
    { id: "p-item", component: "Column", children: ["p-head", "p-text"] },
    { id: "p-head", component: "Text", text: { path: "/head" } },
    { id: "p-text", component: "Text", text: { path: "/text" } },
    { id: "more", component: "List", children: { path: "/more", componentId: "more-item" } },
    { id: "more-item", component: "Button", label: { path: "/label" }, action: "show-more" },
  ],
} as const;

/** The sources panel: each cited passage with its document, place and snippet. Data: published by the page. */
export const SOURCES_VIEW = {
  catalogId: "docmind.v1",
  nodes: [
    { id: "root", component: "Column", children: ["note", "list"] },
    { id: "note", component: "Text", text: { path: "/note" } },
    { id: "list", component: "List", children: { path: "/sources", componentId: "s-item" } },
    {
      id: "s-item",
      component: "Column",
      children: ["s-title", "s-where", "s-snippet", "s-open"],
      selected: { path: "/selected" },
      selectedKey: { path: "/passageId" },
    },
    { id: "s-title", component: "Text", text: { path: "/title" } },
    { id: "s-where", component: "Text", text: { path: "/where" } },
    { id: "s-snippet", component: "Text", text: { path: "/snippet" } },
    { id: "s-open", component: "Button", label: "Open in document", action: "open-source" },
  ],
} as const;
