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
 * it registers nothing. M4 registers the conversation paths below (flow doc-chat) and the ADR 0133
 * reasoning paths (Task 162); the raw event-log proof fails if a path is missing.
 */
export const SENSITIVE_EVENT_PATHS: Readonly<Record<string, readonly string[]>> = {
  // M4: a chat conversation (flow doc-chat) writes user text, replies, model reasoning and
  // tool results into the log. Loom already seals the principal, and (inbox on) INBOX_MESSAGE.payload and
  // MESSAGE_CONSUMED.payload. These are the rest. They name content fields only, so ingest events (ids,
  // counts, codes) are untouched and a fold can still read `choice.role|turn|ord|status`. The tool
  // schemas are strict, so a tool frame's `input` holds only the declared keys, and the text ones are here.
  STEP_STARTED: ["input.messages", "input.query", "input.titleContains"],
  STEP_COMPLETED: [
    "output.content",
    "output.toolCalls[].input",
    "output.value",
    // ADR 0133: the reasoning parts of a model frame (signature, textRef with its size, digest) and the vendor's
    // block order (text lengths). A signature carries the model's encrypted reasoning; the digest of a short
    // summary would let a reader of the log guess it. \`STEP_STARTED.input.messages\` above already seals the
    // assistant reasoning parts that later requests send back. toolCalls[].signature is Gemini's (absent for Claude).
    "output.reasoning",
    "output.layout",
    "output.toolCalls[].signature",
  ],
  DECISION_RECORDED: ["choice.text", "choice.partial", "choice.failed", "choice.error"],
  // Loom writes String(err) here; a tool's collaborator error could carry a query or passage text.
  STEP_FAILED: ["error"],
  EXECUTION_FAILED: ["error"],
  // ADR 0133: the audit event of a captured reasoning text: references, digests and sizes (stepId, attempt, provider
  // and model stay readable: ids and a model name).
  LLM_REASONING_CAPTURED: ["parts"],
  EXECUTION_STARTED: [
    "input.turns[].user",
    "input.turns[].assistant",
    "input.summary",
    "input.pending",
  ],
};
