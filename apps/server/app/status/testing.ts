import type { EventEnvelope } from "@loom/core";
import type { ReadModelEventSource } from "@loom/plugin-read-model";

/** An event the way Loom writes one (fields as in `EventEnvelope`). */
export const evt = (
  executionId: string,
  sequence: number,
  eventType: string,
  payload: unknown = {},
): EventEnvelope => ({
  id: `${executionId}-${sequence}`,
  workflowId: "ingest-document",
  executionId,
  eventType,
  sequence,
  timestamp: 1_000 + sequence,
  payload,
});

/** The events of one ingest execution, from sequence 0: just started, parsing, ready, or failed with a code. */
export function ingestRun(
  executionId: string,
  spec: "started" | "parsed" | "ready" | `failed:${string}`,
): EventEnvelope[] {
  const out: EventEnvelope[] = [evt(executionId, 0, "EXECUTION_STARTED", { input: {} })];
  const step = (type: string, stepId: string, output?: unknown) =>
    out.push(
      evt(executionId, out.length, type, output === undefined ? { stepId } : { stepId, output }),
    );
  if (spec === "started") return out;
  step("STEP_STARTED", "ingest-parse");
  if (spec === "parsed") return out;
  if (spec.startsWith("failed:")) {
    step("STEP_COMPLETED", "ingest-parse", { outcome: "failed", code: spec.slice(7) });
    return out;
  }
  step("STEP_COMPLETED", "ingest-parse", { outcome: "done", count: 1 });
  step("STEP_STARTED", "ingest-finalize");
  step("STEP_COMPLETED", "ingest-finalize", { outcome: "done", count: 1 });
  return out;
}

/** A tiny event log for tests: what Loom's event store is to the model (live source and catch-up source). */
export class MemoryLog implements ReadModelEventSource {
  private readonly byExecution = new Map<string, EventEnvelope[]>();
  append(...events: EventEnvelope[]): void {
    for (const e of events) {
      const list = this.byExecution.get(e.executionId) ?? [];
      list.push(e);
      this.byExecution.set(e.executionId, list);
    }
  }
  events(): EventEnvelope[] {
    return [...this.byExecution.values()].flat();
  }
  async listExecutions(): Promise<string[]> {
    return [...this.byExecution.keys()];
  }
  async readFrom(executionId: string, fromSequence: number): Promise<EventEnvelope[]> {
    return (this.byExecution.get(executionId) ?? []).filter((e) => e.sequence >= fromSequence);
  }
}
