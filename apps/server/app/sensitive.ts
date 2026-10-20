/**
 * Event paths that can carry user content, sealed in the log under the owning user's key.
 *
 * Rules for every flow, agent or tool added later (M3 onwards):
 *  - a flow's start input carries ids only (the `ingest-document` stub: `{ tenantId, userId, documentId }`), never a filename, title or text;
 *  - any step output or event field that can hold user content (document text, summaries, questions,
 *    answers) is listed here, or marked `sensitive(...)` in its schema and derived with
 *    `sensitivePathsFromSteps`; add it in the SAME PR that adds the flow, because an event written
 *    before its path is registered stays readable in the clear forever;
 *  - execution ids are plaintext and survive erasure, so they never contain user content either.
 *
 * M2's only flow (`ingest-document`) has a start input of three UUIDs and a two-value enum output, so
 * it registers nothing. M4 registers the conversation paths below (flow doc-chat), and Task 147b's
 * raw event-log proof fails if a path is missing.
 */
export const SENSITIVE_EVENT_PATHS: Readonly<Record<string, readonly string[]>> = {
  // M4: a chat conversation (flow doc-chat) writes user text, replies, thinking-free model frames and
  // tool results into the log. Loom already seals the principal, and (inbox on) INBOX_MESSAGE.payload and
  // MESSAGE_CONSUMED.payload. These are the rest. They name content fields only, so ingest events (ids,
  // counts, codes) are untouched and a fold can still read `choice.role|turn|ord|status`. The tool
  // schemas are strict, so a tool frame's `input` holds only the declared keys, and the text ones are here.
  STEP_STARTED: ["input.messages", "input.query", "input.titleContains"],
  STEP_COMPLETED: ["output.content", "output.toolCalls[].input", "output.value"],
  DECISION_RECORDED: ["choice.text", "choice.partial", "choice.failed", "choice.error"],
  EXECUTION_STARTED: [
    "input.turns[].user",
    "input.turns[].assistant",
    "input.summary",
    "input.pending",
  ],
};
