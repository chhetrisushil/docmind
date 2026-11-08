# Chat visuals: ambient, planner-composed visuals for chat answers (design)

Date: 2026-11-08. Status: draft for review.

## 1. Goal

Help a user grasp a chat answer faster by attaching the visuals that make it clearer than prose: the
figures and facts behind the answer as charts, metric cards and tables. This is sub-project 2 of
document visuals (`2026-11-08-document-visuals-design.md`, "sub-project 1"). It reuses that
sub-project's catalogue (`docmind.visuals.v1`), fact grounding, planner wiring, sealed lineage and
hydration path.

Visuals are **ambient**: they are composed by a background flow after a turn has settled, never in
the turn's hot path. An answer streams exactly as it does today; its visuals arrive later, or never.

## 2. Decisions

| Id | Decision |
|---|---|
| C1 | Facts are layered. A turn first uses the stored facts (sub-project 1) of the documents its answer cited, kept only when they cite a chunk the answer cited. Only when none survive does the turn extract facts from its own retrieved chunks, with the same grounding rules. |
| C2 | Trigger: automatic for every completed answer that cites at least one document, plus an on-demand "Visualize" / "Re-visualize" action on any cited answer. |
| C3 | Placement: a collapsible "Visuals" strip under the assistant message, collapsed by default, expanding in place. The answer text above it never reflows. |
| C4 | The turn-end trigger is a generic Loom hook, `turnSettledObserver`, added to `@loom/conversation` first (sub-project 1 V7: gaps are closed generically upstream). DocMind does not poll and does not depend on a browser being open. |
| C5 | One lineage per turn, `turnvisuals-<userId>-<chatId>-<ord>`. A re-run replaces its head (sub-project 1 R18). |
| C6 | No backfill and no boot sweep. A turn whose hook call was missed (crash, role off) is recovered by the on-demand action. |
| C7 | Visuals are optional. A failed, empty or disabled run leaves the strip hidden; the turn is never affected. |

Approaches considered and rejected for the trigger (C4): starting `visualize-turn` at message POST
and polling until the turn settles, like `chat-title` (every turn holds a waiting execution and a gate
slot; barge-in and edits make the wait error-prone), and a browser-initiated call when a complete
answer is seen (visuals only while someone is watching; opening an old chat needs guards against
passes for historic turns).

Approaches considered and rejected for the fact source (C1): extracting only from the answer text
(model output is not a source; numbers cannot be grounded), stored facts only (answers over figures
past the summary cap, or over documents without facts, get nothing), and per-turn extraction only (a
model call on every turn even when stored facts already cover it).

## 3. Prerequisite: `turnSettledObserver` in `@loom/conversation`

A generic helper in `@loom/conversation`, naming no DocMind concept, built on the runtime's existing
`onDurableEvent` (ADR 0147). No kernel change. Loom branch `feat/conversation-turn-settled`; the plan
pins the merged Loom SHA in CI.

```ts
turnSettledObserver(flow: { definition: { id: string } }, listener: TurnSettledListener)
  : (event: EventEnvelope) => void | Promise<void>
type TurnSettledListener = (e: TurnSettledEvent) => void | Promise<void>
interface TurnSettledEvent {
  conversationId: string;
  executionId: string;   // the generation, "<id>~n" after a rotation
  turn: number;          // 0 for a rejected message
  ord: number;           // unique within the conversation: the idempotency key
  status: "complete" | "interrupted" | "failed" | "rejected";
  asker?: Identity;      // shared mode only
}
```

- Fires once per settled turn of any conversation of that flow, after the store's write has
  resolved: a history read from the listener sees the reply. An edit is a new turn.
- Never re-fires on replay or restart. Missed if the process dies between write and call (C6).
- A throwing or rejecting listener goes to `onWarn` and never fails the turn.
- Ids and status only, no reply text.
- The listener's synchronous part runs on the runtime's write chain: DocMind's listener only
  enqueues (section 4) and returns.
- One `onDurableEvent` per runtime. DocMind uses none today; it composes one observer per chat flow
  (`doc-chat`, `doc-chat-gk`) into a single function, so later observers compose there too.
- A fork can report its copied prefix again under the fork's id. DocMind keys work by chat and
  `ord`, which covers it.
- The event carries no tenant. DocMind resolves it with a SECURITY DEFINER function
  `docmind_chat_tenant(chat_id)` (migration 0029), like `docmind_ready_documents`.

## 3b. Prerequisite: a per-entry attachment point in loom-ui's Chat widget

`lu-chat` gives a host no place for content under one entry; reaching into its shadow DOM would
depend on internal markup. A generic loom-ui mechanism, naming no DocMind concept, lets the host
render content keyed by chat entry id (`t<turn>.assistant`) inside that entry, stable across
streaming re-renders, through the `dm-view` rendering path, and never on restricted entries.
Requested from the Loom session on 2026-11-08; the plan pins the merged loom-ui SHA before the web
task. Server tasks do not wait for it.

## 4. Trigger

DocMind's turn-settled listener resolves the chat from `conversationId` (`u_<userId>.c-<chatId>`), enqueues the
check below off the write chain, and returns. The queued check starts `visualize-turn` when all hold:

- status is `complete` (not interrupted, failed or rejected);
- the `visuals` role is on;
- the chat exists and is not soft-deleted;
- the answer cites at least one document: its `[[passageId]]` markers, checked by `citeReply`
  against the turn's stored `passages` item, leave at least one citation;
- fewer than 20 visuals executions (document and turn together) are waiting. Otherwise the
  automatic start is dropped, not queued; the message shows only the action.

Execution id `visualize-turn-<chatId>-<ord>` (through `executionIdFor`), so a turn gets at most one
automatic pass; `ExecutionAlreadyExistsError` is swallowed. The start never throws into the hook.

On demand: `POST /api/chats/:id/turns/:ord/visualize` answers 202. It checks the owner, that the chat
is not deleted, and that the turn is a complete, cited answer (else 409 `not_visualizable`). One run
per turn at a time (409 `visualize_running`); at most 10 per user per minute (429). Execution id
`visualize-turn-<chatId>-<ord>-r<n>`, `n` the next re-run number.

All runs share sub-project 1's visuals gate (at most 2 executions in flight), which chat and ingest
never wait behind.

## 5. The flow: `visualize-turn` 1.0.0

Input `{tenantId, userId, chatId, ord}`, strict, ids only. Steps:

1. **`turn-load`.** Reads the turn's `passages` items and reply through the chat's decrypting
   readers; computes the cited passages with `citeReply`. For each cited document still owned, reads
   its stored facts (`PgVisualFacts.list`) and keeps a fact only if its `chunkIds` intersect the
   cited chunk ids. Keeps at most 12, ordered by first citation. Output: the kept facts' references
   (document id, ordinal), never their text.
2. **`turn-extract`.** Runs only when step 1 kept nothing. Reads the full text of the chunks retrieved
   in this turn (documents deleted since are dropped), concatenated in retrieval order and capped at
   `DOCMIND_SUMMARY_MAX_CHARS`. Runs sub-project 1's extraction prompt and grounding (V4, rulings
   R6 to R12) with the chunks as the source. At most 16 facts, stored in `turn_visual_facts`
   (section 6). A refusal or zero grounded facts ends the run with outcome `nothing`.
3. **Planner decision.** The same `ReferencePlanner`, catalogue and keyed decision id
   (`DOCMIND_PLANNER_DECISION_KEY`, R19), with intent: "Illustrate this answer for its reader. Choose
   nothing if no visual adds understanding." Capabilities per fact (R26 shape):
   `docmind:visual.facts@1#<documentId>/fact-<n>` for a stored fact,
   `docmind:turn.facts@1#fact-<n>` for an extracted one. A plan with no widgets ends with `nothing`.
4. **`turn-commit`.** Replaces the head of lineage `turnvisuals-<userId>-<chatId>-<ord>`, sealed
   with the user's key (idempotent, R18), then publishes `{kind: "visuals", ord, outcome}` on `ChatBus`
   for that chat. A run that ends `nothing` also publishes, so an on-demand click resolves.

Output `{outcome: "visualized" | "nothing"}`. Retry policy: 3 attempts,
2 s backoff, ×2 (not `visualize-document`'s per-step policies). Exhausted retries fail the execution with the visuals error type (R20).

## 6. Storage

Migration `0029_turn_visual_facts.sql`: table `turn_visual_facts` (`id`, `tenant_id`, `user_id`,
`chat_id` FK `chat_sessions` ON DELETE CASCADE, `ord`, `ordinal`, `fact_enc` jsonb sealed under bind
`turnfact:<id>`, `chunk_ids uuid[]`), unique (`chat_id`, `ord`, `ordinal`), RLS by tenant and user like
`visual_facts`. A re-run replaces the turn's rows in one transaction.

Lineage content goes to the existing `lineage_content` store. No new settings.

## 7. Serving

- `GET /api/ui/chats/:id/turns/:ord/visuals`: the turn's compiled visuals (catalogue nodes and
  providers), or 404 when the chat is not the user's, is deleted, or the turn has no head.
- `POST /api/ui/hydrate {turn: {chatId, ord}, requests}`: the sub-project 1 hydration path under the
  owner's `sensitive` clearance (R27). `visual.facts` reads re-check document ownership; a deleted
  document's widgets drop out. `turn.facts` reads come from `turn_visual_facts`.
- A view that fails to compile hides the strip (no 500), as in sub-project 1.
- `ChatMessageDto` gains `hasVisuals: boolean` for assistant messages, from one batched head lookup
  per history page.
- `ChatStreamEvent` gains `visuals {ord}`. It carries no content.

## 8. Web

- An assistant message with `hasVisuals`, or after a `visuals` frame for its ord, shows a collapsed
  "Visuals" strip: the first key figure, or a one-row thumbnail of the first chart, plus a count. It
  fetches the widgets when the strip is first shown (the preview needs them) and expands in place.
- Cited answers show "Visualize" (no visuals yet), "Visualizing…" (after 202 until a frame or
  60 s), or "Re-visualize". 409 `visualize_running` shows "Visualizing…"; 429 shows "Try again in a
  minute"; an outcome of `nothing` shows "Nothing to visualize".
- Uncited, interrupted and failed answers show neither.

## 9. Lifecycle and privacy

- Edits and regenerations are new turns with their own visuals; old turns keep theirs (history is
  append-only).
- Chat soft delete: routes refuse; `turn_visual_facts` rows stay until the chat row is removed; the
  lineage line stays unreachable until account erasure (as R25). Erasure destroys it with the user's
  key.
- No answer or fact text reaches the event log in plaintext: step outputs carry references only,
  turn facts are sealed per user, the lineage is sealed, decision ids are keyed.
- Ids contain the user and chat UUIDs in plaintext, as existing execution ids do (R14).

## 10. Testing

- Unit: trigger filter (status, role, deleted chat, uncited, backpressure, duplicate start);
  coverage rule (chunk intersection, cap of 12, citation order, fallback only when empty);
  fallback grounding against retrieved chunks, deleted-document chunks dropped; both pin kinds and
  multi-document pins mapping back to the right fact; idempotent commit and re-run replacement.
- Postgres: `turn_visual_facts` sealing, RLS, cascade, erasure; the visuals route (owner, other user,
  no head, deleted cited document); the visualize route (409 running, 409 not visualizable, 429).
- End to end: a fake model's cited answer → hook → flow → `visuals` frame on the stream → hydrated
  widgets; replay makes no model call.
- Web: strip from history and from a live frame, expand in place, action states and error states.
- Eval: the M7 retrieval fixture gains questions over documents with known figures, measuring the
  stored-versus-fallback rate and wrong facts.

## 11. Out of scope

Visuals for uncited or general-knowledge answers; visuals combining figures across documents
(sub-project 1 step (b)); diagrams (step (c)); user editing, pinning or export of visuals; backfill
of existing turns; shared or multi-user chats; references to visuals from the answer text.
