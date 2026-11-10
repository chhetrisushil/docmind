/** Cuts to at most `max` UTF-16 units, never ending in half a surrogate pair. The one server-side copy. */
export const clipText = (text: string, max: number): string => {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
};
