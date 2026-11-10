import type { Identity } from "@docmind/auth";
import { factFormatFingerprint } from "@docmind/experiences";
import { LineErasedError, type Lineage } from "@loom-ui/lineage";
import {
  ExecutionAlreadyExistsError,
  type ExecutionHandle,
  type RegisteredFlow,
  type WorkflowRuntime,
} from "@loom/workflow-runtime";
import type { Pool } from "pg";
import {
  type UserIdSource,
  documentLineageCandidates,
  existingUser,
  visualizeCandidates,
} from "../../documents/executionCandidates";
import type { ExecutionRecorder } from "../../documents/executionIds";
import { MAX_RERUNS } from "../rerunTracker";
import { rerunTracker } from "../rerunTracker";
import { VisualizeInput } from "./flow";
import { LineageRefusedError } from "./lineage";
import type { VisualizeRef } from "./pgFacts";
import { type VisualRun, type VisualRuns, outcomeOfState } from "./runs";

export { MAX_RERUNS } from "../rerunTracker";

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

/**
 * `docmind_visual_stale_format_documents` (migration 0030): ready documents whose last run ended `done` with a recorded format
 * other than `format` (default: the current fingerprint). A NULL format counts as stale for the connections release (migration 0032).
 */
export const pgStaleFormatDocuments =
  (pool: Pick<Pool, "query">, format: string = factFormatFingerprint()): ReadyDocuments =>
  async (after, limit) => {
    const { rows } = await pool.query<{
      tenant_id: string;
      owner_id: string;
      id: string;
      generation: number;
    }>(
      "SELECT tenant_id, owner_id, id, generation FROM docmind_visual_stale_format_documents($1::uuid, $2::integer, $3::text)",
      [after, limit, format],
    );
    return rows.map((r) => ({
      tenantId: r.tenant_id,
      userId: r.owner_id,
      documentId: r.id,
      generation: Number(r.generation),
    }));
  };

/**
 * `docmind_visual_unrecorded_documents` (migration 0033): ready documents with NO `visual_runs` row for their current generation
 * (visualized before migration 0030 created the table, or never). Ids only; the starter keeps those that have a visuals lineage head.
 */
export const pgUnrecordedDocuments = readyFrom("docmind_visual_unrecorded_documents");

/**
 * True when the document's visuals line has a head (it was visualized with visuals), on its new-format line or, for a document visualized before the
 * deploy, its old one. A confirmed-erased line is "no head". Any other refusal or an unreadable line throws (the caller logs the class and skips the document).
 */
export const hasVisualsHead =
  (lineage: Pick<Lineage, "head">, ids: Pick<UserIdSource, "load" | "cached">) =>
  async (ref: VisualizeRef): Promise<boolean> => {
    const user = await existingUser(ids, ref);
    for (const experienceId of documentLineageCandidates(ref.userId, ref.documentId, user)) {
      try {
        const head = await lineage.head(experienceId);
        if (head.ok) {
          if (head.value !== null) return true;
          continue;
        }
        const { refusal } = head;
        const code = refusal.kind === "refused" ? refusal.finding.code : refusal.kind;
        if (code === "line-erased") continue;
        throw new LineageRefusedError(code);
      } catch (err) {
        if (err instanceof LineErasedError) continue;
        throw err;
      }
    }
    return false;
  };

/** A run recorded as `running` (the boot reconcile's source). */
export interface RunningRun extends ReadyDocument {
  run: number;
}
export type RunningRuns = (after: string, limit: number) => Promise<RunningRun[]>;

/** `docmind_visual_running_runs` (migration 0030): ids and the run number only, across tenants, keyset-paged by document id. */
export const pgRunningRuns =
  (pool: Pick<Pool, "query">): RunningRuns =>
  async (after, limit) => {
    const { rows } = await pool.query<{
      tenant_id: string;
      owner_id: string;
      id: string;
      generation: number;
      run: number;
    }>(
      "SELECT tenant_id, owner_id, id, generation, run FROM docmind_visual_running_runs($1::uuid, $2::integer)",
      [after, limit],
    );
    return rows.map((r) => ({
      tenantId: r.tenant_id,
      userId: r.owner_id,
      documentId: r.id,
      generation: Number(r.generation),
      run: Number(r.run),
    }));
  };

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
   * extracts only when there are none. The one exception is a re-run the user asked for (this method, not a boot pass): it extracts again when the document's stored extraction predates the current format (spec D5, re-extract once). Throws on a Loom failure other than an id already taken.
   */
  rerun(ref: VisualizeRef, generation: number): Promise<VisualsRerun>;
  /** True while a run of this document's `generation` that this process started has not ended. */
  running(ref: Pick<VisualizeRef, "userId" | "documentId">, generation: number): boolean;
  /**
   * A run recorded as `running` that this process is not tracking may have ended with its end event lost (the feed is live
   * only, and its writes are dropped at shutdown). Asks Loom for the execution's state and, when it is terminal, repairs
   * the row from the output (ids and enums only) and answers the repaired run; otherwise answers `last` unchanged. Never throws.
   */
  reconcile(ref: VisualizeRef, generation: number, last: VisualRun): Promise<VisualRun>;
  /** `start` that never throws and is awaited by `idle`: for event callbacks. */
  fire(ref: VisualizeRef, generation: number): void;
  /** Resolves when every fired start has settled (shutdown). */
  idle(): Promise<void>;
  /**
   * Boot sweep: first reconciles the runs recorded as `running` (their end may have been lost), then starts every ready
   * document that has no visualize execution for its generation, then re-runs once every
   * ready document whose last run ended `visuals-model-unavailable`, then once every document whose last run was committed over an
   * older fact format (migration 0030's stamp; a NULL stamp counts as stale, migration 0032), then once every ready document with no run row
   * whose visuals line has a head (visualized before migration 0030; migration 0033), page by page, with at most SWEEP_EXECUTIONS executions
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
  /** The id cache: a start builds the new-format id with the user's key; a read or a cancel also tries the old format. Required: there is no id without it. */
  ids: UserIdSource;
  /** Records the automatic run's id on the document before it starts (migration 0038), so the boot sweeps can compare it with the status rows. */
  executions?: ExecutionRecorder;
  /** The boot sweep's source; absent: the sweep does nothing. */
  ready?: ReadyDocuments;
  /** The boot sweep's second source: documents to re-run (their last run ended `visuals-model-unavailable`); absent: none. */
  retry?: ReadyDocuments;
  /**
   * The boot sweep's third source: documents whose last run ended `done` over an older fact format (the stamp differs from
   * the current fingerprint); each is re-run once per boot. Absent: none.
   */
  stale?: ReadyDocuments;
  /**
   * The boot sweep's fourth source: ready documents with no `visual_runs` row for their generation. Each is re-planned once
   * per boot when `visualized` says it has a visuals lineage head (documents visualized before migration 0030). Needs both; absent: none.
   */
  unrecorded?: ReadyDocuments;
  /** Whether a listed document was ever visualized (has a lineage head), read under its owner. A throw skips that document (class logged). */
  visualized?: (ref: VisualizeRef) => Promise<boolean>;
  /** The boot reconcile's source: runs recorded as `running`; absent: none. */
  running?: RunningRuns;
  /** Records a run as `running` when it starts (so a page shows it and a retry waits for it); absent: nothing is recorded. */
  runs?: Pick<VisualRuns, "record" | "last">;
  /**
   * Shared with the extract step (`ExtractDeps.afterDone`): a re-run started after a `done` run is noted here by its execution
   * id, so it re-plans over the stored facts without extracting even when there are none.
   */
  afterDone?: Set<string>;
  /**
   * Shared with the extract step (`ExtractDeps.reextract`): the execution ids of re-runs the USER asked for (`rerun`, the
   * route's call), so the step extracts again when the stored extraction predates `EXTRACT_FORMAT`. A boot pass never notes
   * one. Ids only; a lost note just means the run re-plans.
   */
  reextract?: Set<string>;
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
  runtime: Pick<WorkflowRuntime, "start" | "cancel"> & Partial<Pick<WorkflowRuntime, "loadState">>,
  flow: RegisteredFlow,
  options: VisualsStarterOptions,
): VisualsStarter {
  const {
    ids,
    executions,
    ready,
    retry,
    stale,
    unrecorded,
    visualized,
    running: runningSource,
    runs,
    afterDone,
    reextract,
    enabled = true,
    pageSize = READY_PAGE,
    onError = logClass("visualize start failed"),
  } = options;
  const pending = new Set<Promise<unknown>>();
  // Pending starts by user and lower-cased document id (never logged), for `settle`.
  const byDocument = new Map<string, Set<Promise<unknown>>>();
  const keyOf = (userId: string, documentId: string) => `${userId}:${documentId.toLowerCase()}`;
  const tracker = rerunTracker();
  // One key per (user, document, ingest generation): the in-flight runs and the highest `-r<n>` taken are per generation.
  const genKey = (userId: string, documentId: string, generation: number) =>
    `${keyOf(userId, documentId)}.${generation}`;
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
    // A key-store outage throws here, before Loom sees anything: a start never falls back to an id with the plain UUIDs.
    const user = await ids.ensureUser({ tenantId: input.tenantId, userId: input.userId });
    const executionId = user.visualize(input.documentId, generation, rerun);
    // The automatic run's id goes on the document BEFORE the start (the boot sweeps compare it with the status rows); a re-run is never swept.
    if (rerun === undefined)
      await executions?.recordVisualize(
        { tenantId: input.tenantId, userId: input.userId },
        input.documentId,
        generation,
        executionId,
      );
    try {
      const handle = await runtime.start(flow, input, {
        // One execution per (document, generation, run): Loom starts a caller-chosen id once. No content in the name.
        executionId,
        principal: { tenant: input.tenantId, actor: input.userId },
      });
      tracker.track(genKey(input.userId, input.documentId, generation), executionId, handle);
      // A noted run that ends without an extraction write (failed, cancelled, document gone) must not leave its note behind.
      if (rerun !== undefined && reextract)
        void handle.waitForCompletion().then(
          () => reextract.delete(executionId),
          () => reextract.delete(executionId),
        );
      // Every run (the automatic one is run 0) is recorded as running once Loom has it, so a restart while Loom recovers it
      // never lets a retry start another beside it. A fast end (recorded by the event feed) is never overwritten: the table
      // does not reopen a finished run.
      await runs
        ?.record(
          { userId: input.userId, documentId: input.documentId, generation, run: rerun ?? 0 },
          "running",
        )
        .catch(onError);
      return handle;
    } catch (err) {
      // The start did not happen: this run's re-extract note (added before the start) must not outlive it.
      if (rerun !== undefined) reextract?.delete(executionId);
      if (err instanceof ExecutionAlreadyExistsError) return null;
      throw err;
    }
  };
  const start = (ref: VisualizeRef, generation: number) => startOne(ref, generation);
  const isRunning = (ref: Pick<VisualizeRef, "userId" | "documentId">, generation: number) =>
    tracker.running(genKey(ref.userId, ref.documentId, generation));

  /** The state of a run under whichever id format it started with (the old-format id first), or null when neither exists. */
  const stateOf = async (ref: VisualizeRef, generation: number, rerun: number | undefined) => {
    const user = await existingUser(ids, ref);
    for (const executionId of visualizeCandidates(
      ref.userId,
      ref.documentId,
      generation,
      rerun,
      user,
    )) {
      const state = await runtime.loadState?.(executionId, {
        principal: { tenant: ref.tenantId, actor: ref.userId },
      });
      if (state) return state;
    }
    return null;
  };

  const reconcile = async (
    ref: VisualizeRef,
    generation: number,
    last: VisualRun,
  ): Promise<VisualRun> => {
    if (last.state !== "running" || isRunning(ref, generation)) return last; // this process is on it
    if (typeof runtime.loadState !== "function") return last;
    try {
      const state = await stateOf(ref, generation, last.run === 0 ? undefined : last.run);
      const end = state ? outcomeOfState(state) : null;
      if (!end) return last; // not started, or still going: recovery or the live feed will finish it
      await runs?.record(
        { userId: ref.userId, documentId: ref.documentId, generation, run: last.run },
        end.state,
        end.code,
      );
      return { run: last.run, state: end.state, code: end.code ?? null };
    } catch (err) {
      onError(err);
      return last;
    }
  };

  /** Records the run-0 outcome of a document that has no visuals head, from the execution's output (as `reconcile`). Never throws. */
  const recordUnvisualized = async (d: ReadyDocument): Promise<void> => {
    try {
      if (typeof runtime.loadState !== "function" || !runs) return;
      const state = await stateOf(d, d.generation, undefined);
      const end = state ? outcomeOfState(state) : null;
      if (!end) return;
      await runs.record(
        { userId: d.userId, documentId: d.documentId, generation: d.generation, run: 0 },
        end.state,
        end.code,
      );
    } catch (err) {
      logClass("visuals unvisualized record failed")(err);
    }
  };

  const rerunWith = async (
    ref: VisualizeRef,
    generation: number,
    assumeDone = false,
    byUser = false,
  ): Promise<VisualsRerun & { handle?: ExecutionHandle }> => {
    if (!enabled) return { kind: "disabled" };
    const user = await ids.ensureUser(ref);
    const key = genKey(ref.userId, ref.documentId, generation);
    // One re-run request at a time per document and generation: the checks, the probe and the start are one step.
    return tracker.exclusive(key, async () => {
      if (tracker.running(key)) return { kind: "running" };
      let last = (await runs?.last(ref, ref.documentId, generation)) ?? null;
      if (last?.state === "running") last = await reconcile(ref, generation, last);
      if (last?.state === "running") return { kind: "running" }; // a run this process does not track, still going (recovered after a restart)
      // `assumeDone`: a document visualized before the runs table has no row but a lineage head; it never extracts.
      const wasDone = assumeDone || last?.state === "done";
      const out = await tracker.probe(key, last?.run ?? 0, (n) => {
        if (wasDone && afterDone) {
          if (afterDone.size >= 1000) afterDone.clear(); // ids only; a lost note just means one extraction
          afterDone.add(user.visualize(ref.documentId, generation, n));
        }
        if (byUser && reextract) {
          // ids only; at the bound the OLDEST notes are evicted (insertion order), never the pending ones wholesale
          while (reextract.size >= 1000) {
            const oldest = reextract.values().next().value;
            if (oldest === undefined) break;
            reextract.delete(oldest);
          }
          reextract.add(user.visualize(ref.documentId, generation, n));
        }
        return startOne(ref, generation, n);
      });
      return out.kind === "started" ? out : { kind: "running" };
    });
  };
  /** Registers a pending operation of the document for `idle` and `settle`; a failure still reaches the caller, not `idle`. */
  const pend = <T>(
    ref: Pick<VisualizeRef, "userId" | "documentId">,
    op: Promise<T>,
  ): Promise<T> => {
    const mark = op.then(
      () => undefined,
      () => undefined,
    );
    pending.add(mark);
    const key = keyOf(ref.userId, ref.documentId);
    const set = byDocument.get(key) ?? new Set<Promise<unknown>>();
    byDocument.set(key, set);
    set.add(mark);
    void mark.finally(() => {
      pending.delete(mark);
      set.delete(mark);
      if (set.size === 0 && byDocument.get(key) === set) byDocument.delete(key);
    });
    return op;
  };
  /** Runs a start that never throws, is awaited by `idle` and by `settle` of its document. */
  const fireWith = (
    ref: VisualizeRef,
    make: () => Promise<ExecutionHandle | null>,
  ): Promise<ExecutionHandle | null> =>
    pend(
      ref,
      make().then(
        (handle) => handle,
        (err: unknown) => {
          onError(err);
          return null;
        },
      ),
    );
  const fire = (ref: VisualizeRef, generation: number) =>
    fireWith(ref, () => start(ref, generation));
  // The route's re-run is tracked like every other start: a delete's `settle` waits for it, then cancels the run it started.
  const rerun = async (ref: VisualizeRef, generation: number): Promise<VisualsRerun> => {
    const { handle: _handle, ...answer } = await pend(ref, rerunWith(ref, generation, false, true));
    return answer;
  };
  return {
    start,
    rerun,
    running: isRunning,
    reconcile,
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
        keep?: (d: ReadyDocument) => Promise<boolean>,
      ) => {
        if (!source) return;
        for (let after = NIL_UUID; !signal?.aborted; ) {
          const page = await source(after, pageSize);
          for (const d of page) {
            if (signal?.aborted) break;
            if (keep && !(await keep(d))) continue;
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
        // First: runs recorded as running whose end event was lost are repaired from Loom's state (a run that is still
        // going stays running). A repaired `visuals-model-unavailable` is stamped now, so the retry pass below (failures over an hour old) leaves it to a later boot.
        // Its own try: a failed reconcile source must not stop the ready and retry passes.
        if (runningSource) {
          try {
            for (let after = NIL_UUID; !signal?.aborted; ) {
              const page = await runningSource(after, pageSize);
              for (const d of page) {
                if (signal?.aborted) break;
                await reconcile(d, d.generation, { run: d.run, state: "running", code: null });
              }
              const last = page[page.length - 1];
              if (!last || page.length < pageSize) break;
              after = last.documentId;
            }
          } catch (err) {
            logClass("visuals running reconcile failed")(err);
          }
        }
        // Each pass has its own try: one failing source must never skip the passes after it.
        try {
          await pass(ready, (d) => fire(d, d.generation));
        } catch (err) {
          logClass("visuals ready pass failed")(err);
        }
        // Once per boot: a document whose last run ended `visuals-model-unavailable` is re-run (the keyset never revisits it,
        // so a run that fails the same way waits for the next boot or the user's retry).
        try {
          await pass(retry, (d) =>
            fireWith(d, async () => {
              const answer = await rerunWith(d, d.generation);
              return answer.kind === "started" ? (answer.handle ?? null) : null;
            }),
          );
        } catch (err) {
          logClass("visuals retry pass failed")(err);
        }
        // Once per boot: a document planned over an older fact format is re-planned over its stored facts (and stamped with the
        // new format when it commits). Its own try, like the others.
        try {
          await pass(stale, (d) =>
            fireWith(d, async () => {
              const answer = await rerunWith(d, d.generation);
              return answer.kind === "started" ? (answer.handle ?? null) : null;
            }),
          );
        } catch (err) {
          logClass("visuals stale-format pass failed")(err);
        }
        // Once per boot: a ready document with no run row whose visuals line has a head (visualized before migration 0030) is
        // re-planned over its stored facts, never extracting. The re-run records a row (any outcome), so it is never listed again.
        // Documents that never produced visuals have no head and are left alone. Its own try, like the others.
        try {
          if (visualized) {
            await pass(
              unrecorded,
              (d) =>
                fireWith(d, async () => {
                  const answer = await rerunWith(d, d.generation, true);
                  return answer.kind === "started" ? (answer.handle ?? null) : null;
                }),
              async (d) => {
                let head: boolean;
                try {
                  head = await visualized(d);
                } catch (err) {
                  logClass("visuals head check failed")(err);
                  return false; // listed again next boot
                }
                // No head: it never produced visuals. Record its run-0 outcome (from Loom's state) so it is never listed
                // again; when that cannot be read, record nothing (listed again next boot; the set does not grow).
                if (!head) await recordUnvisualized(d);
                return head;
              },
            );
          }
        } catch (err) {
          logClass("visuals unrecorded pass failed")(err);
        }
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
      // A run may be under the old id format (from before the deploy) or the new one: cancel every candidate that exists.
      const user = await existingUser(ids, identity);
      const doc = documentId.toLowerCase(); // ids are lower-case; a caller's spelling may not be
      const candidates = (g: number, rerun?: number) =>
        visualizeCandidates(identity.userId, doc, g, rerun, user);
      for (let g = Math.max(1, generation - 1); g <= generation; g++) {
        for (const executionId of candidates(g)) await cancelOne(executionId);
        // The re-runs: numbers are taken in order, up to the highest one this process started or the table recorded.
        const top = Math.max(
          tracker.last(genKey(identity.userId, documentId, g)),
          (await runs?.last(identity, documentId, g))?.run ?? 0,
        );
        for (let n = 1; n <= Math.min(top, MAX_RERUNS); n++)
          for (const executionId of candidates(g, n)) await cancelOne(executionId);
      }
    },
  };
}
