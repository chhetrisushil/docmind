import type { Effect } from "@loom/effect-runtime";
import {
  type DocumentToolDeps,
  documentEffects,
  getSummaryTool,
  listDocumentsTool,
} from "./documents";
import { type ReadDeps, readEffects, readSectionTool, relatedTool } from "./read";
import { type SearchDeps, searchDocsTool, searchEffects } from "./search";

/** The tool definitions the agent offers, in the order of `CHAT_TOOL_IDS`. */
export const CHAT_TOOL_DEFS = [
  searchDocsTool,
  relatedTool,
  readSectionTool,
  getSummaryTool,
  listDocumentsTool,
];

export type ChatToolDeps = SearchDeps & ReadDeps & DocumentToolDeps;

/** The effects behind the tools, keyed by tool id (register them under these ids; the chat flows are granted exactly these). */
export function chatTools(deps: ChatToolDeps): Record<string, Effect> {
  return { ...searchEffects(deps), ...readEffects(deps), ...documentEffects(deps) };
}
