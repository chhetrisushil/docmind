import type { Identity } from "@docmind/auth";
import {
  ExecutionAlreadyExistsError,
  type ExecutionHandle,
  type RegisteredFlow,
  type WorkflowRuntime,
} from "@loom/workflow-runtime";
import type { Pool } from "pg";
import { type UserExecutionId, executionIdFor } from "../../subject";
import { VisualizeInput } from "./flow";
import type { VisualizeRef } from "./pgFacts";

const MAX_GENERATION = 999_999_999; // the execution-id pattern (status/model.ts) allows 9 digits

/**
 * The visualize execution of one ingest generation: `visualize-<doc>` for generation 1, `visualize-<doc>.<gen>`
 * otherwise (mirrors `ingestExecutionId`). The generation is the INGEST generation that turned ready.
 */
export function visualizeExecutionId(
  userId: string,
  documentId: string,
  generation: number,
): UserExecutionId {
  if (!Number.isSafeInteger(generation) || generation < 1 || generation > MAX_GENERATION)
    throw new RangeError("generation must be an integer from 1 to 999999999");
  const id = documentId.toLowerCase();
  return executionIdFor(
    userId,
    generation === 1 ? `visualize-${id}` : `visualize-${id}.${generation}`,
  );
}

/** A page of ready documents with no visualize execution yet (the boot sweep's source). */
export interface ReadyDocument extends VisualizeRef {
  generation: number;
}
export type ReadyDocuments = (after: string, limit: number) => Promise<ReadyDocument[]>;

const NIL_UUID = "00000000-0000-0000-0000-000000000000";
export const READY_PAGE = 200;
/** The most visualize executions the boot sweep keeps running at once (each is a few model calls). */
export const SWEEP_EXECUTIONS = 2;

/** `docmind_ready_documents` (migration 0028): ids only, across tenants, keyset-paged by document id. */
export const pgReadyDocuments =
  (pool: Pick<Pool, "query">): ReadyDocuments =>
  async (after, limit) => {
    const { rows } = await pool.query<{
      tenant_id: string;
      owner_id: string;
      id: string;
      generation: number;
    }>(
      "SELECT tenant_id, owner_id, id, generation FROM docmind_ready_documents($1::uuid, $2::integer)",
      [after, limit],
    );
    return rows.map((r) => ({
      tenantId: r.tenant_id,
      userId: r.owner_id,
      documentId: r.id,
      generation: Number(r.generation),
    }));
  };

export interface VisualsStarter {
  /** Starts the visualize flow of the document's ingest generation once. `null`: it was already started. Throws on a malformed ref or a Loom failure. */
  start(ref: VisualizeRef, generation: number): Promise<ExecutionHandle | null>;
  /** `start` that never throws and is awaited by `idle`: for event callbacks. */
  fire(ref: VisualizeRef, generation: number): void;
  /** Resolves when every fired start has settled (shutdown). */
  idle(): Promise<void>;
  /**
   * Boot sweep: starts every ready document that has no visualize execution for its generation, page by page, with at most SWEEP_EXECUTIONS executions running at once (it resolves when they have all completed).
   * Never throws (a failed page is logged by class and ends the sweep). Returns how many it fired.
   */
  sweep(signal?: AbortSignal): Promise<number>;
  /** Cancels the visualize executions of the document's generation and the one before it (as ingest's cancel). Unknown ones are fine. `reason` is recorded in the log: a fixed word, never content. */
  cancel(identity: Identity, documentId: string, generation: number, reason: string): Promise<void>;
  /** Resolves when the document's pending starts have settled, so a cancel never runs before a start lands. */
  settle(identity: Identity, documentId: string): Promise<void>;
}

const logClass = (what: string) => (err: unknown) =>
  console.error(what, err instanceof Error ? err.constructor.name : typeof err);

export interface VisualsStarterOptions {
  /** The boot sweep's source; absent: the sweep does nothing. */
  ready?: ReadyDocuments;
  /**
   * False while the `visuals` role is off: nothing starts (`start` answers null, the sweep fires nothing), so a
   * deployment without the role records no executions and a later switch-on finds every ready document unvisualized.
   * Default true. Cancel always runs.
   */
  enabled?: boolean;
  /** Documents per sweep page (default READY_PAGE). */
  pageSize?: number;
  onError?: (err: unknown) => void;
}

export function loomVisualsStarter(
  runtime: Pick<WorkflowRuntime, "start" | "cancel">,
  flow: RegisteredFlow,
  options: VisualsStarterOptions = {},
): VisualsStarter {
  const {
    ready,
    enabled = true,
    pageSize = READY_PAGE,
    onError = logClass("visualize start failed"),
  } = options;
  const pending = new Set<Promise<unknown>>();
  // Pending starts by user and lower-cased document id (never logged), for `settle`.
  const byDocument = new Map<string, Set<Promise<unknown>>>();
  const keyOf = (userId: string, documentId: string) => `${userId}:${documentId.toLowerCase()}`;
  const start = async (ref: VisualizeRef, generation: number): Promise<ExecutionHandle | null> => {
    if (!enabled) return null;
    const input = VisualizeInput.parse({
      tenantId: ref.tenantId,
      userId: ref.userId,
      documentId: ref.documentId.toLowerCase(),
    });
    try {
      return await runtime.start(flow, input, {
        // One execution per (document, ingest generation): Loom starts a caller-chosen id once. No content in the name.
        executionId: visualizeExecutionId(input.userId, input.documentId, generation),
        principal: { tenant: input.tenantId, actor: input.userId },
      });
    } catch (err) {
      if (err instanceof ExecutionAlreadyExistsError) return null;
      throw err;
    }
  };
  const fire = (ref: VisualizeRef, generation: number): Promise<ExecutionHandle | null> => {
    const run = start(ref, generation).then(
      (handle) => handle,
      (err: unknown) => {
        onError(err);
        return null;
      },
    );
    pending.add(run);
    const key = keyOf(ref.userId, ref.documentId);
    const runs = byDocument.get(key) ?? new Set<Promise<unknown>>();
    byDocument.set(key, runs);
    runs.add(run);
    void run.finally(() => {
      pending.delete(run);
      runs.delete(run);
      if (runs.size === 0 && byDocument.get(key) === runs) byDocument.delete(key);
    });
    return run;
  };
  return {
    start,
    fire: (ref, generation) => void fire(ref, generation),
    async settle(identity, documentId) {
      while (true) {
        const runs = byDocument.get(keyOf(identity.userId, documentId));
        if (!runs || runs.size === 0) return;
        await Promise.all([...runs]);
      }
    },
    async idle() {
      while (pending.size > 0) await Promise.all([...pending]);
    },
    async sweep(signal) {
      if (!ready || !enabled) return 0;
      let fired = 0;
      // Bounds in-flight EXECUTIONS, not just starts: a slot frees when the execution completes (or fails).
      const running = new Set<Promise<void>>();
      try {
        for (let after = NIL_UUID; !signal?.aborted; ) {
          const page = await ready(after, pageSize);
          for (const d of page) {
            while (running.size >= SWEEP_EXECUTIONS && !signal?.aborted)
              await Promise.race(running);
            if (signal?.aborted) break;
            const run: Promise<void> = fire(d, d.generation)
              .then((handle) => handle?.waitForCompletion())
              .then(
                () => undefined,
                logClass("visualize execution failed"), // a failed or cancelled execution frees its slot
              )
              .finally(() => running.delete(run));
            running.add(run);
            fired++;
          }
          const last = page[page.length - 1];
          if (!last || page.length < pageSize) break;
          after = last.documentId;
        }
      } catch (err) {
        logClass("visualize sweep failed")(err);
      }
      if (!signal?.aborted) await Promise.all(running);
      return fired;
    },
    async cancel(identity, documentId, generation, reason) {
      const principal = { tenant: identity.tenantId, actor: identity.userId };
      for (let g = Math.max(1, generation - 1); g <= generation; g++) {
        const executionId = visualizeExecutionId(identity.userId, documentId, g);
        try {
          await runtime.cancel(executionId, reason, { principal });
        } catch (err) {
          // Loom throws a plain Error (no class) for an execution that never existed; match its exact message for this id only.
          if (
            !(err instanceof Error && err.message === `No execution found for id: ${executionId}`)
          )
            throw err;
        }
      }
    },
  };
}
