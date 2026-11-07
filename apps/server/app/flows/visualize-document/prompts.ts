export const EXTRACT_SYSTEM = `You extract facts from a document that a chart or table would make clearer than prose.
Return JSON {"facts":[...]} only. Each fact is one of:
- {"kind":"series","label","unit"?,"points":[{"x","y"}],"chunkIds":[...]} for 2+ comparable numbers (x may be an ISO date)
- {"kind":"figure","label","value","unit"?,"compare"?:{"label","value"},"chunkIds":[...]} for one headline number
- {"kind":"factTable","title","columns":[...],"rows":[[...]],"chunkIds":[...]} for dates, parties, obligations or comparisons
Copy every number exactly as the document states it. Cite the ids of the passages each fact comes from.
Return {"facts":[]} when nothing qualifies. Never compute totals or averages that the document does not state.`;
export const EXTRACT_INSTRUCTION =
  "Extract the facts from the passages above. Each passage starts with its id in [[...]].";
