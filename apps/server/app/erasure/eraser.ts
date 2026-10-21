import type { Identity } from "@docmind/auth";
import { SHUTDOWN_DRAIN_MS, drainWithin } from "../shutdown";
import { ERASURE_STEPS, type ErasureRequest, type ErasureStep, type ErasureStore } from "./types";

/** The order is the contract (D3): a step never runs before the one above it is recorded. */
export const STEP_ORDER: readonly ErasureStep[] = ERASURE_STEPS;

/**
 * Failed attempts of one step between two "stuck" warnings: the first at attempt 10, then 20, 30, ... Not every
 * attempt, so a step that retries for hours writes a handful of lines, not thousands.
 */
export const ERASURE_STUCK_AFTER = 10;

/** Erasures that execute at once in one process (each holds one lock connection); the rest queue. */
export const ERASURE_CONCURRENCY = 2;

/** How often the pending requests are looked at again (a lock held by a node that has since died). */
export const ERASURE_RESCAN_MS = 5 * 60_000;

/** 1 s, 2 s, 4 s ... at most 60 s. `attempt` counts from 1. */
export const backoffMs = (attempt: number): number =>
  Math.min(60_000, 1_000 * 2 ** Math.min(Math.max(attempt, 1) - 1, 6));

/** Resolves after `ms`, or at once when `signal` aborts. Never rejects. */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}

/** A running chat turn (or ingest step) still owns an execution: the shred must wait for it. */
export class ErasureParkedError extends Error {
  constructor() {
    super("an execution of the user is still running");
    this.name = "ErasureParkedError";
  }
}

/** The shred reported the user erased but the key store still has a live key. */
export class KeyNotDestroyedError extends Error {
  constructor() {
    super("the user's key is still alive after the shred");
    this.name = "KeyNotDestroyedError";
  }
}

/** The release function of a held lock. `lost` aborts when the lock's connection failed: the lock is gone. */
export type ErasureLock = (() => Promise<void>) & { lost?: AbortSignal };

/** What the user owns that the `stop` step must wind down. Ids only. */
export interface ErasureWork {
  documents: { id: string; generation: number }[];
  /** Every chat id, soft-deleted ones included. */
  chatIds: string[];
}

/**
 * Every collaborator the steps need, as the narrowest function each. `wire.ts` builds the real ones;
 * the unit tests build fakes.
 */
export interface ErasureDeps {
  store: Pick<ErasureStore, "pending" | "erased" | "mark" | "retried" | "get">;
  /** The cross-process lock for one user; null when another process holds it. The returned function releases it. */
  lock(userId: string): Promise<ErasureLock | null>;
  /** The user's documents (with their ingest generation) and chats, read under the tenant. */
  work(req: ErasureRequest): Promise<ErasureWork>;
  /** Ends the user's open document and chat streams. */
  closeStreams(userId: string): void;
  /** Waits (bounded) for the document's pending ingest start, so a cancel never runs before it lands. */
  settleStart(identity: Identity, documentId: string): Promise<void>;
  settleTitles(): Promise<void>;
  cancelIngest(identity: Identity, documentId: string, generation: number): Promise<void>;
  /** Fires the chat's stop signal, then closes its conversation; tolerates a conversation that is gone. */
  stopChat(identity: Identity, chatId: string): Promise<void>;
  cancelTitle(identity: Identity, chatId: string): Promise<void>;
  /**
   * `app.eraseSubject(userId, undefined, { parked: "shred" })`. The tenant argument is undefined on purpose:
   * DocMind has no `tenantOf`, so Loom's subject index has one partition, and a tenant id would answer `unknown`.
   */
  eraseSubject(userId: string): Promise<{ outcome: "erased" | "parked" | "unknown" }>;
  keys: {
    destroy(subjectId: string): Promise<void>;
    wasDestroyed(subjectId: string): Promise<boolean>;
  };
  forgetStatus(userId: string): Promise<unknown>;
  forgetActivity(userId: string): Promise<unknown>;
  /** The user row (cascade), leftover Loom timers and leases, the empty personal tenant. */
  rows(req: ErasureRequest): Promise<void>;
  blobs(req: ErasureRequest): Promise<void>;
  /** Test seam: the backoff wait. Defaults to `abortableSleep`. */
  sleep?(ms: number, signal: AbortSignal): Promise<void>;
  /** Where the stuck warning goes (one line, no ids). Defaults to `console.warn`. */
  log?(line: string): void;
}

const LOST = Symbol("lock lost");

/** Where a run that backed off picks up: the label that failed and its next attempt number (the log cadence continues). */
interface Resume {
  label: string;
  attempt: number;
}
/** A failed attempt that waits `delayMs` outside the slot and the lock, then runs again from `resume`. */
interface Retry {
  retry: true;
  delayMs: number;
  resume: Resume;
}
const isRetry = (v: unknown): v is Retry => typeof v === "object" && v !== null && "retry" in v;

/** The lock's connection failed while the run held it. Only its class is ever logged. */
class LockLostError extends Error {
  constructor() {
    super("the erasure lock was lost");
    this.name = "LockLostError";
  }
}

const classOf = (err: unknown) => (err instanceof Error ? err.constructor.name : typeof err);

/**
 * Runs durable erasure requests (D3, D4). It logs a step's name, the error class and the attempt (and, every
 * `ERASURE_STUCK_AFTER` failed attempts of one step, the stuck line), and nothing else: no user id, email, title,
 * file name, key, receipt or connection string.
 */
export class Eraser {
  private readonly runs = new Map<string, Promise<void>>();
  /** resumeAll and re-scan passes in flight: stop() and idle() cover them. */
  private readonly background = new Set<Promise<unknown>>();
  private readonly halt = new AbortController();
  private active = 0;
  private readonly queue: (() => void)[] = [];
  private rescanTimer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly deps: ErasureDeps) {}

  /**
   * Erases the user, or resumes the erasure. Single-flight per user; at most `ERASURE_CONCURRENCY` runs execute at
   * once and the rest queue here. Resolves when done or stopped; never rejects.
   */
  run(userId: string): Promise<void> {
    const live = this.runs.get(userId);
    if (live) return live;
    const run: Promise<void> = this.loop(userId)
      .catch((err: unknown) => this.report("run", err, 1))
      .finally(() => {
        if (this.runs.get(userId) === run) this.runs.delete(userId);
      });
    this.runs.set(userId, run);
    return run;
  }

  /**
   * One drive per slot. A failure that needs a backoff gives the slot (and the lock) back, sleeps without them, and
   * takes a slot again afterwards, so a user stuck in backoff never blocks another user's run.
   */
  private async loop(userId: string): Promise<void> {
    let resume: Resume | undefined;
    for (;;) {
      const free = await this.slot();
      let retry: Retry | undefined;
      try {
        retry = await this.drive(userId, resume);
      } finally {
        free();
      }
      if (!retry) return;
      await (this.deps.sleep ?? abortableSleep)(retry.delayMs, this.halt.signal);
      if (this.halt.signal.aborted) return; // stopped during the delay: no re-enqueue
      resume = retry.resume;
    }
  }

  /** Waits for one of the `ERASURE_CONCURRENCY` slots; the returned function gives it to the next in line. */
  private slot(): Promise<() => void> {
    const free = () => {
      const next = this.queue.shift();
      if (next) next();
      else this.active -= 1;
    };
    if (this.active < ERASURE_CONCURRENCY) {
      this.active += 1;
      return Promise.resolve(free);
    }
    return new Promise((resolve) => this.queue.push(() => resolve(free)));
  }

  private track<T>(work: Promise<T>): Promise<T> {
    this.background.add(work);
    const done = () => void this.background.delete(work);
    work.then(done, done);
    return work;
  }

  /** Enqueues every pending request (boot) and re-forgets the erased users. The server must not wait on the runs. */
  resumeAll(): Promise<void> {
    return this.track(this.resume());
  }

  /** Every ERASURE_RESCAN_MS, enqueues the pending requests this process is not running (a lock held by a node that has since died). */
  startRescan(): void {
    if (this.rescanTimer || this.halt.signal.aborted) return;
    this.rescanTimer = setInterval(() => void this.track(this.rescan()), ERASURE_RESCAN_MS);
    this.rescanTimer.unref?.();
  }

  private async rescan(): Promise<void> {
    try {
      for (const request of await this.deps.store.pending()) {
        if (this.halt.signal.aborted) return;
        if (!this.runs.has(request.userId)) void this.run(request.userId);
      }
    } catch (err) {
      this.report("rescan", err, 1);
    }
  }

  private async resume(): Promise<void> {
    let pending: ErasureRequest[];
    try {
      pending = await this.deps.store.pending();
    } catch (err) {
      this.report("resume", err, 1);
      return;
    }
    for (const request of pending) void this.run(request.userId);
    // Finished erasures: a rebuild or version bump re-creates an erased execution's read-model row as `{}`.
    // Forgetting is idempotent and cheap (it lists only rows that are not tombstoned yet). Always runs, after the
    // read models have booted (this is called from `afterListen`).
    let erased: string[];
    try {
      erased = await this.deps.store.erased();
    } catch (err) {
      this.report("resume", err, 1);
      return;
    }
    for (const userId of erased) {
      if (this.halt.signal.aborted) return; // the models are about to close
      // One user's failure (a fold gap, a key that is unavailable) must not stop the others. Class only.
      try {
        await this.deps.forgetStatus(userId);
        await this.deps.forgetActivity(userId);
      } catch (err) {
        this.report("resume", err, 1);
      }
    }
  }

  /** Resolves when every run and background pass started so far has settled (tests). */
  async idle(): Promise<void> {
    while (this.runs.size > 0 || this.background.size > 0)
      await Promise.all([...this.runs.values(), ...this.background]);
  }

  /** Shutdown: ends every backoff wait, lets a step already running finish (bounded), starts no new step. */
  async stop(): Promise<void> {
    this.halt.abort();
    if (this.rescanTimer) clearInterval(this.rescanTimer);
    this.rescanTimer = undefined;
    await drainWithin(this.idle(), SHUTDOWN_DRAIN_MS);
  }

  /** One pass under a slot. Undefined when finished or stopped; a `Retry` when a backoff is due. */
  private async drive(userId: string, resume?: Resume): Promise<Retry | undefined> {
    // A lost lock (its connection dropped) sends the run back to acquire it again, through the normal backoff.
    const again = resume?.label === "lost" ? resume.attempt : 1;
    const lock = await this.guarded(
      "lock",
      () => this.deps.lock(userId),
      undefined,
      undefined,
      resume,
    );
    if (isRetry(lock)) return lock;
    if (!lock || lock === LOST || !lock.value) return; // stopped, or another process holds the lock
    const release = lock.value;
    let outcome: "finished" | "lost" | Retry;
    try {
      outcome = await this.holding(userId, release.lost, resume);
    } finally {
      await release().catch(() => undefined);
    }
    if (outcome === "finished") return;
    if (isRetry(outcome)) return outcome;
    this.report("lock", new LockLostError(), again);
    return {
      retry: true,
      delayMs: backoffMs(again),
      resume: { label: "lost", attempt: again + 1 },
    };
  }

  private async holding(
    userId: string,
    lost?: AbortSignal,
    resume?: Resume,
  ): Promise<"finished" | "lost" | Retry> {
    const found = await this.guarded(
      "get",
      () => this.deps.store.get(userId),
      undefined,
      lost,
      resume,
    );
    if (isRetry(found)) return found;
    if (found === LOST) return "lost";
    const req = found?.value;
    if (!req || req.state === "done") return "finished";
    const recorded = new Set<ErasureStep>(req.steps);
    for (const step of STEP_ORDER) {
      if (recorded.has(step)) continue;
      const done = await this.attempt(req, step, lost, resume);
      if (isRetry(done)) return done;
      if (done === LOST) return "lost";
      if (!done) return "finished"; // stopped
      recorded.add(step);
    }
    return "finished";
  }

  /**
   * `work`, with the same logging cadence as a step. A failure is not slept on here (that would hold the slot and
   * the lock): it returns a `Retry`, and the run backs off outside both. Null when the eraser was stopped first.
   */
  private async guarded<T>(
    label: string,
    work: () => Promise<T>,
    onFail?: () => Promise<unknown>,
    lost?: AbortSignal,
    resume?: Resume,
  ): Promise<{ value: T } | null | typeof LOST | Retry> {
    const attempt = resume?.label === label ? resume.attempt : 1;
    if (this.halt.signal.aborted) return null;
    if (lost?.aborted) return LOST; // no step runs without the lock
    try {
      const value = await work();
      if (lost?.aborted) return LOST; // the lock went while the step ran: do not record it under a lock we lost
      return { value };
    } catch (err) {
      // Attempts 1, 2 and 3, then every 10th: a step that retries for hours writes a handful of lines.
      if (attempt <= 3 || attempt % ERASURE_STUCK_AFTER === 0) this.report(label, err, attempt);
      if (attempt % ERASURE_STUCK_AFTER === 0) this.warnStuck(label, err, attempt);
      await onFail?.().catch(() => undefined);
      return {
        retry: true,
        delayMs: backoffMs(attempt),
        resume: { label, attempt: attempt + 1 },
      };
    }
  }

  /** One step until it succeeds and is recorded. False when the eraser was stopped first. */
  private async attempt(
    req: ErasureRequest,
    step: ErasureStep,
    lost?: AbortSignal,
    resume?: Resume,
  ): Promise<boolean | typeof LOST | Retry> {
    const done = await this.guarded(
      step,
      async () => {
        await this.step(req, step);
        if (lost?.aborted) return; // `guarded` sees the loss; the step is idempotent and runs again under the new lock
        await this.deps.store.mark(req.userId, step);
      },
      () => this.deps.store.retried(req.userId), // best effort: the count is for operators
      lost,
      resume,
    );
    if (isRetry(done) || done === LOST) return done;
    return done !== null;
  }

  private report(step: string, err: unknown, attempt: number): void {
    console.error("erasure step failed", step, classOf(err), attempt);
  }

  /** One line for an operator: the step, the error class and the attempt count. Never an id or a message. */
  private warnStuck(step: string, err: unknown, attempt: number): void {
    const line = `erasure stuck ${step} ${classOf(err)} attempts=${attempt}`;
    (this.deps.log ?? ((l: string) => console.warn(l)))(line);
  }

  private async step(req: ErasureRequest, step: ErasureStep): Promise<void> {
    const { deps } = this;
    switch (step) {
      case "stop":
        return this.stopWork(req);
      case "shred": {
        const { outcome } = await deps.eraseSubject(req.userId);
        if (outcome === "parked") {
          // A turn is still running. Stop whatever started since, then wait and ask again.
          await this.stopWork(req);
          throw new ErasureParkedError();
        }
        // 'unknown': the user owns no execution. 'erased': the shred destroyed the key itself (E2).
        if (outcome === "erased" && !(await deps.keys.wasDestroyed(req.userId)))
          throw new KeyNotDestroyedError();
        return;
      }
      case "readModels":
        await deps.forgetStatus(req.userId);
        await deps.forgetActivity(req.userId);
        return;
      case "rows":
        return deps.rows(req);
      case "blobs":
        return deps.blobs(req);
      case "key":
        // Idempotent; covers a user the shred never saw. Then the blobs once more: an upload that was
        // already streaming when the erase began may have landed after the first sweep (E9).
        await deps.keys.destroy(req.userId);
        if (!(await deps.keys.wasDestroyed(req.userId))) throw new KeyNotDestroyedError();
        return deps.blobs(req);
      case "done":
        return; // `mark` records the state
    }
  }

  /**
   * Step 1: nothing of the user may still be running or startable. Idempotent, and safe to repeat. The route
   * deletes the sessions before it starts the eraser, so no new request of the user can arrive meanwhile.
   * Ingest cancel covers generations max(1, generation - 1) to generation (older ones are terminal by the retry rule).
   */
  private async stopWork(req: ErasureRequest): Promise<void> {
    const { deps } = this;
    const identity: Identity = { tenantId: req.tenantId, userId: req.userId };
    deps.closeStreams(req.userId);
    const work = await deps.work(req);
    for (const doc of work.documents) {
      await deps.settleStart(identity, doc.id);
      await deps.cancelIngest(identity, doc.id, doc.generation);
    }
    for (const chatId of work.chatIds) {
      await deps.stopChat(identity, chatId);
      await deps.cancelTitle(identity, chatId);
    }
    await deps.settleTitles();
  }
}
