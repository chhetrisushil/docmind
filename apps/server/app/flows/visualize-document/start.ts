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
import type { VisualRuns } from "./runs";

const MAX_GENERATION = 999_999_999; // the execution-id pattern (status/model.ts) allows 9 digits
export const MAX_RERUNS = 999; // `-r<n>`: the execution-id pattern (status/model.ts) allows 3 digits

/**
 * The visualize execution of one ingest generation: `visualize-<doc>` for generation 1, `visualize-<doc>.<gen>`
 * otherwise (mirrors `ingestExecutionId`). The generation is the INGEST generation that turned ready. `rerun` makes
 * `<that id>-r<n>`, an on-demand re-run of the same generation (n from 1 to 999).
 */
export function visualizeExecutionId(
  userId: string,
  documentId: string,
  generation: number,
  rerun?: number,
): UserExecutionId {
  if (!Number.isSafeInteger(generation) || generation < 1 || generation > MAX_GENERATION)
    throw new RangeError("generation must be an integer from 1 to 999999999");
  if (rerun !== undefined && (!Number.isSafeInteger(rerun) || rerun < 1 || rerun > MAX_RERUNS))
    throw new RangeError("rerun must be an integer from 1 to 999");
  const id = documentId.toLowerCase();
  return executionIdFor(
    userId,
    `${generation === 1 ? `visualize-${id}` : `visualize-${id}.${generation}`}${rerun === undefined ? "" : `-r${rerun}`}`,
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

const readyFrom =
  (fn: string) =>
  (pool: Pick<Pool, "query">): ReadyDocuments =>
  async (after, limit) => {
    const { rows } = await pool.query<{
      tenant_id: string;
      owner_id: string;
      id: string;
      generation: number;
    }>(`SELECT tenant_id, owner_id, id, generation FROM ${fn}($1::uuid, $2::integer)`, [
      after,
      limit,
    ]);
    return rows.map((r) => ({
      tenantId: r.tenant_id,
      userId: r.owner_id,
      documentId: r.id,
      generation: Number(r.generation),
    }));
  };

/** `docmind_ready_documents` (migration 0028): ids only, across tenants, keyset-paged by document id. */
export const pgReadyDocuments = readyFrom("docmind_ready_documents");

/** `docmind_visual_retry_documents` (migration 0030): ready documents whose last visualize run ended `visuals-model-unavailable`. */
export const pgRetryDocuments = readyFrom("docmind_visual_retry_documents");

/** What a re-run request answers: started (the `-r<n>` it took), a run of the document is in flight, or the visuals role is off. */
export type VisualsRerun =
  | { kind: "started"; rerun: number }
  | { kind: "running" }
  | { kind: "disabled" };

export interface VisualsStarter {
  /** Starts the visualize flow of the document's ingest generation once. `null`: it was already started. Throws on a malformed ref or a Loom failure. */
  start(ref: VisualizeRef, generation: number): Promise<ExecutionHandle | null>;
  /**
   * On demand: re-runs the document's visuals for `generation` as `<id>-r<n>` with the next free number, unless a run of
   * the document is in flight (or every number is taken: also `running`). The run re-plans over the stored facts and
   * extracts only when there are none. Throws on a Loom failure other than an id already taken.
   */
  rerun(ref: VisualizeRef, generation: number): Promise<VisualsRerun>;
  /** True while a run of this document that this process started has not ended. */
  running(ref: Pick<VisualizeRef, "userId" | "documentId">): boolean;
  /** `start` that never throws and is awaited by `idle`: for event callbacks. */
  fire(ref: VisualizeRef, generation: number): void;
  /** Resolves when every fired start has settled (shutdown). */
  idle(): Promise<void>;
  /**
   * Boot sweep: starts every ready document that has no visualize execution for its generation, then re-runs once every
   * ready document whose last run ended `visuals-model-unavailable`, page by page, with at most SWEEP_EXECUTIONS executions
   * running at once (it resolves when they have all completed).
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
  /** The boot sweep's second source: documents to re-run (their last run ended `visuals-model-unavailable`); absent: none. */
  retry?: ReadyDocuments;
  /** Records a re-run as `running` (so a page shows it and the sweep leaves it alone); absent: nothing is recorded. */
  runs?: Pick<VisualRuns, "record" | "last">;
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
    retry,
    runs,
    enabled = true,
    pageSize = READY_PAGE,
    onError = logClass("visualize start failed"),
  } = options;
  const pending = new Set<Promise<unknown>>();
  // Pending starts by user and lower-cased document id (never logged), for `settle`.
  const byDocument = new Map<string, Set<Promise<unknown>>>();
  const keyOf = (userId: string, documentId: string) => `${userId}:${documentId.toLowerCase()}`;
  // Executions this process started and has not seen end, by user and lower-cased document id: what `rerun` reads as "running".
  const inFlight = new Map<string, Set<string>>();
  const lastRerun = new Map<string, number>(); // `<user>:<doc>.<gen>` -> the highest `-r<n>` this process started
  const track = (key: string, executionId: string, handle: ExecutionHandle) => {
    if (typeof handle.waitForCompletion !== "function") return;
    const set = inFlight.get(key) ?? new Set<string>();
    inFlight.set(key, set);
    set.add(executionId);
    void handle
      .waitForCompletion()
      .then(
        () => undefined,
        () => undefined, // a failed run frees the document too
      )
      .finally(() => {
        set.delete(executionId);
        if (set.size === 0 && inFlight.get(key) === set) inFlight.delete(key);
      });
  };
  const startOne = async (
    ref: VisualizeRef,
    generation: number,
    rerun?: number,
  ): Promise<ExecutionHandle | null> => {
    if (!enabled) return null;
    const input = VisualizeInput.parse({
      tenantId: ref.tenantId,
      userId: ref.userId,
      documentId: ref.documentId.toLowerCase(),
    });
    const executionId = visualizeExecutionId(input.userId, input.documentId, generation, rerun);
    try {
      // The run is recorded as running once Loom has it: a fast end (recorded by the event feed) is never overwritten, because
      // the table never reopens a finished run.
      const handle = await runtime.start(flow, input, {
        // One execution per (document, generation, run): Loom starts a caller-chosen id once. No content in the name.
        executionId,
        principal: { tenant: input.tenantId, actor: input.userId },
      });
      track(keyOf(input.userId, input.documentId), executionId, handle);
      if (rerun !== undefined)
        await runs
          ?.record(
            { userId: input.userId, documentId: input.documentId, generation, run: rerun },
            "running",
          )
          .catch(onError);
      return handle;
    } catch (err) {
      if (err instanceof ExecutionAlreadyExistsError) return null;
      throw err;
    }
  };
  const start = (ref: VisualizeRef, generation: number) => startOne(ref, generation);
  const isRunning = (ref: Pick<VisualizeRef, "userId" | "documentId">) =>
    (inFlight.get(keyOf(ref.userId, ref.documentId))?.size ?? 0) > 0;
  const rerunWith = async (
    ref: VisualizeRef,
    generation: number,
  ): Promise<VisualsRerun & { handle?: ExecutionHandle }> => {
    if (!enabled) return { kind: "disabled" };
    if (isRunning(ref)) return { kind: "running" };
    const last = await runs?.last(ref, ref.documentId, generation);
    if (last?.state === "running") return { kind: "running" }; // a run this process did not start (recovered after a restart)
    const key = `${keyOf(ref.userId, ref.documentId)}.${generation}`;
    for (let n = (lastRerun.get(key) ?? 0) + 1; n <= MAX_RERUNS; n++) {
      const handle = await startOne(ref, generation, n);
      if (handle) {
        lastRerun.set(key, n);
        return { kind: "started", rerun: n, handle };
      }
    }
    return { kind: "running" }; // every re-run number is taken: nothing more can start, so the document answers as busy (never a 500)
  };
  /** Runs a start that never throws, is awaited by `idle` and by `settle` of its document. */
  const fireWith = (
    ref: VisualizeRef,
    make: () => Promise<ExecutionHandle | null>,
  ): Promise<ExecutionHandle | null> => {
    const run = make().then(
      (handle) => handle,
      (err: unknown) => {
        onError(err);
        return null;
      },
    );
    pending.add(run);
    const key = keyOf(ref.userId, ref.documentId);
    const set = byDocument.get(key) ?? new Set<Promise<unknown>>();
    byDocument.set(key, set);
    set.add(run);
    void run.finally(() => {
      pending.delete(run);
      set.delete(run);
      if (set.size === 0 && byDocument.get(key) === set) byDocument.delete(key);
    });
    return run;
  };
  const fire = (ref: VisualizeRef, generation: number) =>
    fireWith(ref, () => start(ref, generation));
  const rerun = async (ref: VisualizeRef, generation: number): Promise<VisualsRerun> => {
    const { handle: _handle, ...answer } = await rerunWith(ref, generation);
    return answer;
  };
  return {
    start,
    rerun,
    running: isRunning,
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
      if (!enabled) return 0;
      let fired = 0;
      // Bounds in-flight EXECUTIONS, not just starts: a slot frees when the execution completes (or fails).
      const running = new Set<Promise<void>>();
      /** One source, page by page. `go` starts a document and resolves with its handle (null: nothing started). */
      const pass = async (
        source: ReadyDocuments | undefined,
        go: (d: ReadyDocument) => Promise<ExecutionHandle | null>,
      ) => {
        if (!source) return;
        for (let after = NIL_UUID; !signal?.aborted; ) {
          const page = await source(after, pageSize);
          for (const d of page) {
            while (running.size >= SWEEP_EXECUTIONS && !signal?.aborted)
              await Promise.race(running);
            if (signal?.aborted) break;
            const run: Promise<void> = go(d)
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
      };
      try {
        await pass(ready, (d) => fire(d, d.generation));
        // Once per boot: a document whose last run ended `visuals-model-unavailable` is re-run (the keyset never revisits it,
        // so a run that fails the same way waits for the next boot or the user's retry).
        await pass(retry, (d) =>
          fireWith(d, async () => {
            const answer = await rerunWith(d, d.generation);
            return answer.kind === "started" ? (answer.handle ?? null) : null;
          }),
        );
      } catch (err) {
        logClass("visualize sweep failed")(err);
      }
      if (!signal?.aborted) await Promise.all(running);
      return fired;
    },
    async cancel(identity, documentId, generation, reason) {
      const principal = { tenant: identity.tenantId, actor: identity.userId };
      // Loom throws a plain Error (no class) for an execution that never existed; match its exact message for this id only.
      const cancelOne = async (executionId: string): Promise<boolean> => {
        try {
          await runtime.cancel(executionId, reason, { principal });
          return true;
        } catch (err) {
          if (
            !(err instanceof Error && err.message === `No execution found for id: ${executionId}`)
          )
            throw err;
          return false;
        }
      };
      for (let g = Math.max(1, generation - 1); g <= generation; g++) {
        await cancelOne(visualizeExecutionId(identity.userId, documentId, g));
        // The re-runs: numbers are taken in order, up to the highest one this process started or the table recorded.
        const key = `${keyOf(identity.userId, documentId)}.${g}`;
        const top = Math.max(
          lastRerun.get(key) ?? 0,
          (await runs?.last(identity, documentId, g))?.run ?? 0,
        );
        for (let n = 1; n <= Math.min(top, MAX_RERUNS); n++)
          await cancelOne(visualizeExecutionId(identity.userId, documentId, g, n));
      }
    },
  };
}
