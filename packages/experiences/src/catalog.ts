import { type KindContract, type SemanticCatalog, defineSemanticCatalog } from "@loom-ui/core";

/** The surfaces DocMind compiles for. Adding one means adding a key to every entry below, nothing else. */
export const SURFACES = ["web", "terminal"] as const;

/** The loom contracts of the framework kinds DocMind uses (the same as `frameworkKindContracts` and `chatKindContracts` of the renderers). */
export const KINDS = {
  Kpi: { kind: "Kpi", props: ["unit", "format"], binding: "required" },
  Table: { kind: "Table", props: [], binding: "required" },
  StatusCard: { kind: "StatusCard", props: [], binding: "required" },
  Note: { kind: "Note", props: ["text"], binding: "none" },
  A2UIView: { kind: "A2UIView", props: ["view"], binding: "required" },
  Chat: { kind: "Chat", props: ["emptyText", "editable"], binding: "required" },
  TextInput: {
    kind: "TextInput",
    props: ["label", "placeholder", "multiline", "maxChars", "submitLabel"],
    binding: "none",
  },
  SelectInput: { kind: "SelectInput", props: ["label", "options", "placeholder"], binding: "none" },
} as const satisfies Record<string, KindContract>;
export type KindName = keyof typeof KINDS;

/** Entry name to kind: DocMind's whole vocabulary. */
export const ENTRY_KINDS = {
  LibraryKpi: "Kpi",
  IngestHealth: "StatusCard",
  DocumentTable: "Table",
  StatusFilter: "SelectInput",
  Notice: "Note",
  DocumentHealth: "StatusCard",
  DocumentKpi: "Kpi",
  DocumentFacts: "Table",
  DocumentSummary: "A2UIView",
  DocumentContent: "A2UIView",
  Transcript: "Chat",
  Composer: "TextInput",
  ScopeSelect: "SelectInput",
  ChatSearch: "TextInput",
  ChatTable: "Table",
  SourcesPanel: "A2UIView",
} as const satisfies Record<string, KindName>;
export type EntryName = keyof typeof ENTRY_KINDS;

export const DOCMIND_CATALOG: SemanticCatalog = defineSemanticCatalog({
  id: "docmind.v1",
  entries: Object.entries(ENTRY_KINDS).map(([name, kind]) => ({
    name,
    version: "1.0.0",
    props: [...KINDS[kind].props],
    ...(kind === "Note" && { textProps: ["text"] }),
    binding: KINDS[kind].binding,
    surfaces: Object.fromEntries(SURFACES.map((s) => [s, KINDS[kind]])),
  })),
});
