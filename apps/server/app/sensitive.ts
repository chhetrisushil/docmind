/**
 * The id fields of a flow's start input (and of each step's input, which is the same ref). They are ids, not content, but the ids of a user, a
 * document and a chat in a plaintext payload would link an erased user's records after the key is gone (R14), so they are sealed with the rest.
 */
const FLOW_INPUT_IDS = [
  "input.tenantId",
  "input.userId",
  "input.documentId",
  "input.chatId",
] as const;

/**
 * Event paths that can carry user content, sealed in the log under the owning user's key.
 *
 * Rules for every flow, agent or tool added later (M3 onwards):
 *  - a flow's start input carries ids only (the `ingest-document` stub: `{ tenantId, userId, documentId }`), never a filename, title or text; the ids
 *    themselves are sealed (`FLOW_INPUT_IDS`), so no plain user, document or chat id is left in a payload once the key is gone;
 *  - any step output or event field that can hold user content (document text, summaries, questions,
 *    answers) is listed here, or marked `sensitive(...)` in its schema and derived with
 *    `sensitivePathsFromSteps`; add it in the SAME PR that adds the flow, because an event written
 *    before its path is registered stays readable in the clear forever;
 *  - the conversation's own owner and sender identities are ids too and are sealed (EXECUTION_STARTED.input.owner, MESSAGE_CONSUMED.sender),
 *    for the same reason as FLOW_INPUT_IDS;
 *  - execution ids are plaintext and survive erasure, so they never contain user content either.
 *
 * M2's only flow (`ingest-document`) has a start input of three ids (sealed by `FLOW_INPUT_IDS`, not listed per flow) and a two-value
 * enum output, so it registers no content path of its own. M4 registers the conversation paths below (flow doc-chat) and the ADR 0133
 * reasoning paths (Task 162); the raw event-log proof fails if a path is missing.
 */
export const SENSITIVE_EVENT_PATHS: Readonly<Record<string, readonly string[]>> = {
  // M4: a chat conversation (flow doc-chat) writes user text, replies, model reasoning and
  // tool results into the log. Loom already seals the principal, and (inbox on) INBOX_MESSAGE.payload and
  // MESSAGE_CONSUMED.payload. These are the rest. They name content fields only, so ingest events (ids,
  // counts, codes) are untouched and a fold can still read `choice.role|turn|ord|status`. The tool
  // schemas are strict, so a tool frame's `input` holds only the declared keys, and the text ones are here.
  STEP_STARTED: [
    "input.messages",
    "input.query",
    "input.titleContains",
    // The visualize commit step (`visualize-commit`): the planned ops (labels, bindings), the model's summary and the
    // planner's report (findings quoting model output and fact paths).
    "input.ops",
    "input.summary",
    "input.report",
    ...FLOW_INPUT_IDS,
  ],
  STEP_COMPLETED: [
    "output.content",
    "output.toolCalls[].input",
    "output.value",
    // The rolling summary of evicted turns (`conv#o<ord>:summarize`, `createSummarizerEffect` → `{ summary }`).
    "output.summary",
    // ADR 0133: the reasoning parts of a model frame (signature, textRef with its size, digest) and the vendor's
    // block order (text lengths). A signature carries the model's encrypted reasoning; the digest of a short
    // summary would let a reader of the log guess it. `STEP_STARTED.input.messages` above already seals the
    // assistant reasoning parts that later requests send back. toolCalls[].signature is Gemini's (absent for Claude).
    "output.reasoning",
    "output.layout",
    "output.toolCalls[].signature",
    // The visualize load step (`visualize-load`): the document's extracted facts (labels, values, table cells).
    "output.facts",
  ],
  DECISION_RECORDED: [
    "choice.text",
    "choice.partial",
    "choice.failed",
    "choice.error",
    // The visuals planner's decision (loom-ui ReferencePlanner.compose records its whole PlanResult as the
    // choice): the ops carry labels and bindings made from document facts, `summary` is model text, and
    // `findings` and the report's per-attempt findings quote model output and fact paths.
    "choice.ops",
    "choice.summary",
    "choice.findings",
    "choice.report",
  ],
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
    // The conversation's own owner identity (`{ actor, tenant }`: the user and tenant UUIDs). Loom does not seal it with `principal`, and
    // beside an `h_<H>` execution id it would link the erased handle to the user for good (R14 phase 2).
    "input.owner",
    ...FLOW_INPUT_IDS,
  ],
  // The sender of a consumed conversation message is its owner's identity too: the same `{ actor, tenant }`. Loom seals only this event's
  // `payload`. (`INBOX_MESSAGE.sender` is not listed: Loom already seals it under the sender subject, ADR 0139 N6.)
  MESSAGE_CONSUMED: ["sender"],
};
