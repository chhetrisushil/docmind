import type { Citation } from "./chats";
import { locatorText } from "./locator";

export interface SourcesData {
  note: string;
  /** `index` is the item's place in this list: the action's context carries it and `intentOf` resolves the item from the held list by it. */
  sources: {
    title: string;
    where: string;
    snippet: string;
    passageId: string;
    documentId: string;
    /** True for the one citation the reader picked; the view highlights it. Order never changes. */
    selected: boolean;
    index: number;
  }[];
}

/**
 * The data of the `sources` experience, from the citations of one answer. Surface-neutral and pure: the browser publishes it
 * into the view's store because citations are built on read and only the client holds them.
 */
export function sourcesValue(citations: readonly Citation[], selected?: string): SourcesData {
  if (citations.length === 0)
    return { note: "Sources appear when the answer is complete.", sources: [] };
  return {
    note: `${citations.length} ${citations.length === 1 ? "source" : "sources"} for this answer.`,
    sources: citations.map((c, index) => ({
      title: c.docTitle === "" ? "Untitled document" : c.docTitle,
      where: locatorText(c.locator),
      snippet: c.snippet,
      passageId: c.passageId,
      documentId: c.documentId,
      selected: selected !== undefined && c.passageId === selected,
      index,
    })),
  };
}
