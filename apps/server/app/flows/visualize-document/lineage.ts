import { type Experience, genesis, replay } from "@loom-ui/core";
import {
  type Committed,
  LineErasedError,
  LineUnreadableError,
  Lineage,
  type LineageResult,
  eventStoreLineageStore,
} from "@loom-ui/lineage";
import { type PlanResult, plannerProvenance } from "@loom-ui/planner";
import type { EventStore } from "@loom/event-runtime";
import type { ContentStore } from "@loom/plugin-content";
import type { KeyStore } from "@loom/plugin-crypto";
import type { VisualizeRef } from "./pgFacts";
import { VISUALS_INTENT } from "./plan";

/** The planner's id in the provenance of the ops it composed. */
export const VISUALIZER_AGENT_ID = "docmind-visualizer";

/**
 * The lineage line of a document's visuals. Ids only: the id is stored in plaintext and survives erasure
 * (S/subject.ts parses it back to the owner, so the shape is part of the erasure contract).
 */
export const experienceIdOf = (ref: VisualizeRef) => `visuals-${ref.userId}-${ref.documentId}`;

/** What a commit needs of a plan: the ops and what the planner said about them. */
export type CommitPlan = Pick<PlanResult, "ops" | "report" | "summary" | "summaryClass">;

/** The head kept moving under the commit, even after a retry. */
export class HeadMovedError extends Error {
  constructor() {
    super("the visuals line's head moved during the commit");
    this.name = "HeadMovedError";
  }
}

/** The lineage refused a write for a reason a retry cannot fix. Carries the finding code only (never its message). */
export class LineageRefusedError extends Error {
  constructor(readonly code: string) {
    super(`the lineage refused the commit: ${code}`);
    this.name = "LineageRefusedError";
  }
}

/**
 * The visuals `Lineage`. `events` must be the sealing event store (`EncryptingEventStore`) and `content` the
 * `EncryptingContentStore` over the same KeyStore and subject mapping (S/storage.ts `sealedLineageContent`):
 * the line is then owned by its user, and a destroyed key reads as an erasure (`line-erased`).
 * `subjectOf` is the mapping both stores run.
 */
export function visualsLineage(deps: {
  events: EventStore;
  content: ContentStore;
  keys: Pick<KeyStore, "wasDestroyed">;
  subjectOf: (e: { executionId: string }) => string;
}): Lineage {
  // Fail closed: the artifacts hold the plan's labels and values, so a store that does not seal per subject is refused.
  if ((deps.content as { sealsContent?: unknown }).sealsContent !== true)
    throw new Error("visualsLineage needs a sealing content store (sealsContent: true)");
  const store = eventStoreLineageStore(deps.events);
  return new Lineage({
    events: store,
    content: deps.content,
    confirmErased: async (experienceId) =>
      (await deps.keys.wasDestroyed?.(
        deps.subjectOf({ executionId: `${store.streamPrefix}${experienceId}` }),
      )) === true,
  });
}

function unwrap<T>(experienceId: string, result: LineageResult<T>): T | "head-moved" {
  if (result.ok) return result.value;
  const { refusal } = result;
  if (refusal.kind === "head-moved") return "head-moved";
  const code = refusal.kind === "refused" ? refusal.finding.code : refusal.kind;
  if (code === "line-erased") throw new LineErasedError(experienceId);
  if (code === "line-unreadable" || code === "artifact-unsealed")
    throw new LineUnreadableError(experienceId, { reason: code });
  throw new LineageRefusedError(code);
}

/** JSON with sorted keys: two structurally equal values give the same text whatever their key order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Commits the plan as the document's visuals: the head's content becomes exactly the plan's nodes (R18). A plan's
 * ops are relative to an empty experience, so a later commit first removes every root child of the head, then adds
 * the plan's. A head that already equals the plan's replay (a step retry or a resume after a commit) is returned
 * as it is, with nothing written. A head that moved in between is re-read once; moving again throws
 * `HeadMovedError`. A line whose owner was erased throws `LineErasedError` (the commit step reports `document_gone`).
 */
export async function commitPlan(
  lineage: Lineage,
  ref: VisualizeRef,
  plan: CommitPlan,
  now: () => string,
): Promise<{ head: string }> {
  const experienceId = experienceIdOf(ref);
  const by = plannerProvenance(plan, { agentId: VISUALIZER_AGENT_ID });
  const emptyGenesis = () =>
    genesis({
      experienceId,
      intent: VISUALS_INTENT,
      // No content: the author and source are fixed labels, the time is the commit's.
      meta: { author: VISUALIZER_AGENT_ID, createdAt: now(), sourceKind: "document-visuals" },
    });
  const wanted = replay(emptyGenesis(), plan.ops);
  if (!wanted.ok) throw new LineageRefusedError(wanted.finding.code);
  const wantedRoot = canonical(wanted.value.root);
  for (let attempt = 0; attempt < 2; attempt++) {
    const read = unwrap(experienceId, await lineage.head(experienceId));
    if (read === "head-moved") continue;
    let current: Experience;
    if (read === null) {
      const started = unwrap(experienceId, await lineage.start(emptyGenesis(), by));
      if (started === "head-moved") continue; // a concurrent start won; read its head
      current = (started as Committed).experience;
    } else {
      const latest = unwrap(experienceId, await lineage.resolveLatest(experienceId));
      if (latest === "head-moved") continue;
      current = latest;
    }
    if (canonical(current.root) === wantedRoot) return { head: current.versionHash };
    const children = (current.root as { children?: readonly { id: string }[] }).children ?? [];
    const clear = children.map((c) => ({ type: "removeNode" as const, nodeId: c.id }));
    const composed = unwrap(
      experienceId,
      await lineage.compose({
        experienceId,
        expectedHead: current.versionHash,
        ops: [...clear, ...plan.ops].map((op) => ({ op, by, at: now() })),
        by,
        ...(plan.summary !== undefined && { summary: plan.summary }),
        ...(plan.summaryClass !== undefined && { summaryClass: plan.summaryClass }),
      }),
    );
    if (composed === "head-moved") continue;
    return { head: (composed as Committed).version.versionHash };
  }
  throw new HeadMovedError();
}
