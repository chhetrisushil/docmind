/** Where a passage sits, in words. Accepts a stored locator or a citation's (a citation's keeps extra fields). */
export function locatorText(l: { kind: string; [k: string]: unknown }): string {
  switch (l.kind) {
    case "page":
      return typeof l.page === "number" ? `Page ${l.page}` : "Somewhere in the document";
    case "section":
      return typeof l.index === "number" ? `Section ${l.index + 1}` : "Somewhere in the document";
    case "chars":
      return `Characters ${String(l.start)}-${String(l.end)}`;
    case "paragraphs":
      return `Paragraphs ${String(l.from)}-${String(l.to)}`;
    case "region":
      return typeof l.page === "number" ? `Page ${l.page}, region` : "Somewhere in the document";
    default:
      return "Somewhere in the document";
  }
}
