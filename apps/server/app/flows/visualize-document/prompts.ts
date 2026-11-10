export const EXTRACT_SYSTEM = `You extract facts from a document that a chart or table would make clearer than prose.
Return JSON {"facts":[...]} only. Each fact is one of:
- {"kind":"series","label","unit"?,"points":[{"x","y"}],"chunkIds":[...]} for 2+ comparable numbers (x may be an ISO date)
- {"kind":"figure","label","value","unit"?,"compare"?:{"label","value"},"chunkIds":[...]} for one headline number
- {"kind":"factTable","title","columns":[...],"rows":[[...]],"chunkIds":[...]} for dates, parties, obligations or comparisons
Copy every number exactly as the document states it. Cite the ids of the passages each fact comes from.
Return {"facts":[]} when nothing qualifies. Never compute totals or averages that the document does not state.`;
/** The document extraction's extra ask: the dated events and the stated relationships, beside the facts. Chat never sends it. */
const aggregatesAsk = (
  events: number,
  links: number,
) => `The JSON object may also carry two more top-level fields next to "facts". Leave a field out when the document does not support it.
- "timeline": {"events":[{"when","date","label","chunkIds":[...]}]}, the dated events the document narrates, at most ${events}, in any order.
  "when" is the date exactly as the document writes it. "date" is that same date as YYYY, YYYY-Qn, YYYY-MM or YYYY-MM-DD, at the precision the document gives (a quarter is YYYY-Q1 to YYYY-Q4).
  Never infer, compute or complete a date. Leave out an event whose date is relative ("last year", "next month", "recently") or missing.
  "label" is a short description of the event, at most 80 characters.
- "relations": {"links":[{"from","rel","to","chunkIds":[...]}]}, how the parties the document names relate to each other, at most ${links}.
  "from" and "to" are parties exactly as the document names them. "rel" is a short verb phrase of at most 40 characters ("acquired", "leads", "reports to").
Cite at most 2 passage ids in "chunkIds" for each event and each link.
Copy dates, names and phrases as the document states them. Leave "timeline" out when fewer than 3 events qualify and "relations" out when fewer than 3 links qualify.`;
/** The most events and links one document may keep (the normalisers' caps); a window is asked for its share of them. */
export const ASKED_EVENTS = 40;
export const ASKED_LINKS = 30;
/** The least a window is asked for, however many windows there are. */
export const ASK_FLOOR = 3;
/** The prompt for one window of a document of `windowCount` windows: it asks for at most its share of events and links. */
export function extractDocumentSystem(windowCount: number): string {
  const n = Math.max(1, windowCount);
  const share = (cap: number) => Math.max(ASK_FLOOR, Math.ceil(cap / n));
  return `${EXTRACT_SYSTEM}\n\n${aggregatesAsk(share(ASKED_EVENTS), share(ASKED_LINKS))}`;
}
/** What a DOCUMENT extraction sends for a one-window document: the facts prompt, then the aggregates. It starts with `EXTRACT_SYSTEM`'s first sentence. */
export const EXTRACT_DOCUMENT_SYSTEM = extractDocumentSystem(1);
export const EXTRACT_INSTRUCTION =
  "Extract the facts from the passages above. Each passage starts with its id in [[...]].";
