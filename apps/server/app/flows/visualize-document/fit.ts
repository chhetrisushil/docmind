import { type FactRef, type VisualFactRaw, factRefOfPin, fitsShape } from "@docmind/experiences";
import type { Operation } from "@loom-ui/core";

/** The fact a provider handle reads, from the `remapProvider` op that declares it; null for a provider this module did not mint. */
function factOfHandle(op: Operation): { handle: string; ref: FactRef | null } | null {
  if (op.type !== "remapProvider") return null;
  const step = op.spec.executionGraph[0];
  return {
    handle: op.handle,
    ref: step ? factRefOfPin(step.toolName, step.toolSchemaHash) : null,
  };
}

/**
 * Removes from a decided plan the widgets whose fact does not fit them, so hydration never draws a `reshape-failed`
 * placeholder: each `insertNode` that binds a provider reading a fact is run through the reshaper hydration uses
 * (`fitsShape`) against the fact `factOf` finds (a fact that is gone fits nothing). A dropped node takes with it any
 * container left with no child, nested ones included, and any provider no node reads any more. Widgets that read no
 * fact (the connections widgets) are never judged. `dropped` is the catalogue entry names, in plan order: never a fact's
 * text. A pure function of the decided ops and the stored facts: it changes no catalogue and no planner decision.
 */
export function dropUnfittingOps(
  ops: readonly Operation[],
  factOf: (ref: FactRef) => VisualFactRaw | undefined,
): { ops: Operation[]; dropped: string[] } {
  const refs = new Map<string, FactRef | null>();
  for (const op of ops) {
    const p = factOfHandle(op);
    if (p) refs.set(p.handle, p.ref);
  }
  const containers = new Set<string>();
  for (const op of ops)
    if (op.type === "insertNode" && op.parentId !== "root") containers.add(op.parentId);
  const gone = new Set<Operation>();
  const dropped: string[] = [];
  for (const op of ops) {
    if (op.type !== "insertNode") continue;
    const handle = (op.node as { binding?: { handle?: string } }).binding?.handle;
    const ref = handle === undefined ? null : (refs.get(handle) ?? null);
    const entry = (op.node as { type?: string }).type;
    if (ref === null || entry === undefined) continue; // binds no fact (or not one of ours): not this check's to judge
    if (fitsShape(entry, factOf(ref))) continue;
    gone.add(op);
    dropped.push(entry);
  }
  // A container with no surviving child goes too; a removed container empties its own parent, so repeat to a fixpoint.
  for (let changed = true; changed; ) {
    changed = false;
    for (const op of ops) {
      if (op.type !== "insertNode" || gone.has(op) || !containers.has(op.node.id)) continue;
      const alive = ops.some(
        (c) => c.type === "insertNode" && !gone.has(c) && c.parentId === op.node.id,
      );
      if (!alive) {
        gone.add(op);
        changed = true;
      }
    }
  }
  const used = new Set<string>();
  for (const op of ops) {
    const h =
      op.type === "insertNode"
        ? (op.node as { binding?: { handle?: string } }).binding?.handle
        : undefined;
    if (h !== undefined && !gone.has(op)) used.add(h);
  }
  const kept = ops.filter(
    (op) =>
      !gone.has(op) &&
      !(op.type === "remapProvider" && refs.get(op.handle) && !used.has(op.handle)),
  );
  return { ops: kept, dropped };
}

/** Logs what `dropUnfittingOps` dropped: the entry names and the count only, never a fact's text. */
export function logDropped(flow: string, dropped: readonly string[]): void {
  if (dropped.length > 0) console.warn(`${flow} dropped widgets whose fact does not fit`, dropped);
}
