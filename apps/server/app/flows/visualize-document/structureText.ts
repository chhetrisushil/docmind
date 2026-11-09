/** The longest label (a heading or an entity name) a structure fact keeps. */
export const MAX_STRUCTURE_LABEL = 80;

/** Cuts to at most `max` UTF-16 units, never ending in half a surrogate pair. */
export const clipText = (text: string, max: number): string => {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
};

/** A heading or a name as a label: trimmed and clipped to 80 characters; "" when nothing is left. */
export const clipLabel = (raw: string): string =>
  clipText(raw.trim(), MAX_STRUCTURE_LABEL).trimEnd();
