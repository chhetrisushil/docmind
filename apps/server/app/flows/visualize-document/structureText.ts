import { clipText } from "../../http/clip";

/** The longest label (a heading or an entity name) a structure fact keeps. */
export const MAX_STRUCTURE_LABEL = 80;

/** A heading or a name as a label: trimmed and clipped to 80 UTF-16 units (an astral character counts 2); "" when nothing is left. */
export const clipLabel = (raw: string): string =>
  clipText(raw.trim(), MAX_STRUCTURE_LABEL).trimEnd();
