# Snapshot Pruning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep only the latest snapshot of each chat conversation and delete the superseded ones on a schedule, one replica at a time.

**Architecture:** A `snapshots/pruner.ts` module holds the sweep (page the `u_…` executions, keep chat conversations, call `prune(id)` for each, under a session advisory lock) and an interval runner modelled on `documents/sweeper.ts`. `snapshots/pgPruner.ts` binds it to production: Loom's `LogLifecycle.pruneSnapshots(id, { keepLatest: 1 })` over the RAW stores, on a `LogLifecycle` built WITHOUT `compactionExempt`, and a session advisory lock on the Loom pool. `bootIngest` starts it after listen and drains it with the upload sweeper at shutdown.

**Tech Stack:** TypeScript (ESM), Node >= 22.13, vitest 2, node-postgres, Loom `@loom/workflow-runtime` (`LogLifecycle`, SnapshotStore SPI 1.3.0), pnpm + turbo, biome.

**Spec:** `docs/specs/2026-11-03-snapshot-pruning-design.md`

## Global Constraints

- Variable: `DOCMIND_SNAPSHOT_PRUNE_INTERVAL_MS`, default `3600000` (1 h); `0` disables the pruner; otherwise at least `60000` and at most `604800000` (7 days); anything else fails the boot with `StartupConfigError` naming the variable only (never the value).
- `keepLatest: 1`. Only executions `isChatExecution` accepts (every generation, `…~<n>`) are pruned. Ingest executions are never pruned.
- The app's `durability.retention.compactionExempt` in `config.ts` is NOT changed.
- The pruner uses `DurableStorage.raw` (never the sealed stores) and never reads a key.
- The first sweep runs one interval after `afterListen`, never at boot.
- Logs are ids-free: counts, durations, and error CLASS names only (`err.constructor.name`), never `err.message`.
- Every commit ends with the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Commands run from the repo root unless a step says otherwise. Postgres suites need `DOCMIND_TEST_PG_URL` (load it with `set -a; . ./.env; set +a`); without it they are skipped, which is NOT a pass for this plan.

---

## File Structure

| File | Responsibility |
|---|---|
| `apps/server/app/db/sessionLock.ts` (new) | `pgSessionLock(pool, key, label)`: a session advisory lock on its own connection, with a `lost` signal. Extracted from `erasure/pgSteps.ts`. |
| `apps/server/app/db/sessionLock.pg.test.ts` (new) | The lock against Postgres. |
| `apps/server/app/erasure/pgSteps.ts` (modify) | `pgErasureLock` delegates to `pgSessionLock`. |
| `apps/server/app/erasure/eraser.ts` (modify) | `ErasureLock` becomes an alias of `SessionLock`. |
| `apps/server/app/snapshots/pruner.ts` (new) | Env parsing, `sweepChatSnapshots`, `startSnapshotPruner`. No Postgres, no Loom imports. |
| `apps/server/app/snapshots/pruner.test.ts` (new) | Unit tests with fakes. |
| `apps/server/app/snapshots/pgPruner.ts` (new) | `snapshotPruneDeps(durable)`: the production `LogLifecycle`, listing and lock. |
| `apps/server/app/snapshots/prune.e2e.pg.test.ts` (new) | Acceptance: real chats, real stores, restart, lock, erasure, the timer. |
| `apps/server/app/setup.ts`, `main.ts`, `bootIngest.ts`, `documents/ingestStack.ts` (modify) | Load the variable; start and drain the pruner. |
| `.env.example`, `docs/operations/cloud-deploy.md`, `docs/architecture.md`, `docs/design/cloud-scaling.md`, `docs/specs/2026-11-03-snapshot-pruning-design.md` (modify) | Docs. |

---

### Task 1: Extract the session advisory lock

**Files:**
- Create: `apps/server/app/db/sessionLock.ts`
- Create: `apps/server/app/db/sessionLock.pg.test.ts`
- Modify: `apps/server/app/erasure/pgSteps.ts` (the body of `pgErasureLock`, currently lines 20-75)
- Modify: `apps/server/app/erasure/eraser.ts:55`

**Interfaces:**
- Produces: `export type SessionLock = (() => Promise<void>) & { lost?: AbortSignal };` and `export async function pgSessionLock(pool: Pool, key: string, label: string): Promise<SessionLock | null>` from `apps/server/app/db/sessionLock.ts`. `label` prefixes the log lines (`"<label> connection failed"`).

- [ ] **Step 1: Write the failing Postgres test**

Create `apps/server/app/db/sessionLock.pg.test.ts`:

```ts
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pgSessionLock } from "./sessionLock";
import { PG_URL, type TestDb, createTestDb } from "./testSupport";

describe.skipIf(!PG_URL)("pgSessionLock (needs DOCMIND_TEST_PG_URL)", () => {
  let db: TestDb;
  let pool: Pool;
  beforeAll(async () => {
    db = await createTestDb();
    pool = new Pool({ connectionString: db.loomUrl, max: 4 });
  });
  afterAll(async () => {
    await pool.end();
    await db.drop();
  });

  it("is held by one session at a time and can be taken again once released", async () => {
    const first = await pgSessionLock(pool, "test:one", "test lock");
    expect(first).not.toBeNull();
    expect(await pgSessionLock(pool, "test:one", "test lock")).toBeNull();
    // a different key is independent
    const other = await pgSessionLock(pool, "test:two", "test lock");
    expect(other).not.toBeNull();
    await other?.();
    await first?.();
    const again = await pgSessionLock(pool, "test:one", "test lock");
    expect(again).not.toBeNull();
    await again?.();
  });

  it("returns every connection to the pool, held or refused", async () => {
    const held = await pgSessionLock(pool, "test:pool", "test lock");
    await pgSessionLock(pool, "test:pool", "test lock"); // refused: its connection goes straight back
    await held?.();
    expect(pool.totalCount - pool.idleCount).toBe(0);
  });

  it("reports a lock whose connection died as lost", async () => {
    const held = await pgSessionLock(pool, "test:lost", "test lock");
    expect(held?.lost?.aborted).toBe(false);
    const owner = new Pool({ connectionString: db.loomUrl, max: 1 });
    try {
      await owner.query(
        "SELECT pg_terminate_backend(pid) FROM pg_locks WHERE locktype = 'advisory' AND objid = (hashtextextended('test:lost', 0) & 4294967295)::oid AND pid <> pg_backend_pid()",
      );
    } finally {
      await owner.end();
    }
    await expect.poll(() => held?.lost?.aborted, { timeout: 5_000 }).toBe(true);
    await held?.(); // releasing a lost lock is a no-op, never a throw
  });
});
```

Before running it, check that `createTestDb()` returns an object with `loomUrl` and `drop()` (`apps/server/app/db/testSupport.ts`); `config.test.ts` uses `db.loomUrl`. If the role behind `loomUrl` cannot call `pg_terminate_backend` on its own sessions, use `db.owner` (the owner pool `TestDb` exposes) for the `owner` query instead.

- [ ] **Step 2: Run it to verify it fails**

Run: `set -a; . ./.env; set +a; cd apps/server && pnpm exec vitest run app/db/sessionLock.pg.test.ts`
Expected: FAIL, `Failed to resolve import "./sessionLock"`.

- [ ] **Step 3: Implement `sessionLock.ts`**

Create `apps/server/app/db/sessionLock.ts` (the body moved from `pgErasureLock`, with the key and the log label as parameters):

```ts
import type { Pool } from "pg";

/** The release function of a held session lock. `lost` aborts when the lock's connection failed: the lock is gone. */
export type SessionLock = (() => Promise<void>) & { lost?: AbortSignal };

/**
 * A session advisory lock (`pg_try_advisory_lock(hashtextextended(key, 0))`) on a connection of its own, held
 * until released. A dead connection drops the lock by itself, and `lost` says so. Null when another session holds
 * it. `label` names the lock in the log lines, which carry an error's class only.
 */
export async function pgSessionLock(
  pool: Pool,
  key: string,
  label: string,
): Promise<SessionLock | null> {
  const client = await pool.connect();
  // A held connection that drops loses the lock: tell the holder (`lost`) instead of crashing the process.
  const gone = new AbortController();
  const onError = (err: unknown) => {
    console.error(
      `${label} connection failed`,
      err instanceof Error ? err.constructor.name : typeof err,
    );
    gone.abort();
  };
  client.on("error", onError);
  const done = (destroy?: Error) => {
    client.removeListener("error", onError);
    client.release(destroy ?? (gone.signal.aborted ? new Error("lock connection lost") : undefined));
  };
  try {
    const { rows } = await client.query(
      "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS held",
      [key],
    );
    if (!rows[0].held) {
      done();
      return null;
    }
  } catch (err) {
    done(err instanceof Error ? err : new Error("lock failed"));
    throw err;
  }
  const release: SessionLock = async () => {
    try {
      if (gone.signal.aborted) return done(); // the lock went with the connection
      await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [key]);
      done();
    } catch (err) {
      done(err instanceof Error ? err : new Error("unlock failed")); // destroys the connection, and the lock with it
    }
  };
  release.lost = gone.signal;
  return release;
}
```

- [ ] **Step 4: Make `pgErasureLock` delegate**

In `apps/server/app/erasure/pgSteps.ts`, replace the whole `pgErasureLock` function (keep its doc comment) with:

```ts
export function pgErasureLock(pool: Pool): ErasureDeps["lock"] {
  // An idle lock connection dropped by the server must not crash the process. Class only.
  pool.on("error", (err) =>
    console.error(
      "idle erasure lock connection failed",
      err instanceof Error ? err.constructor.name : typeof err,
    ),
  );
  return (userId) => pgSessionLock(pool, `erasure:${userId}`, "erasure lock");
}
```

Add `import { pgSessionLock } from "../db/sessionLock";` and remove the now-unused `ErasureLock` import from `pgSteps.ts` if biome reports it. The key (`erasure:<user>`) and the log text (`erasure lock connection failed`) are unchanged.

In `apps/server/app/erasure/eraser.ts:55`, replace

```ts
export type ErasureLock = (() => Promise<void>) & { lost?: AbortSignal };
```

with

```ts
export type { SessionLock as ErasureLock } from "../db/sessionLock";
```

and, if `eraser.ts` itself uses `ErasureLock` as a type, add `import type { SessionLock as ErasureLock } from "../db/sessionLock";` instead of the re-export plus keep `export type { ErasureLock };` so other importers still compile.

- [ ] **Step 5: Run the lock test, the erasure suites and the typecheck**

Run: `set -a; . ./.env; set +a; cd apps/server && pnpm exec vitest run app/db/sessionLock.pg.test.ts app/erasure && pnpm typecheck && pnpm typecheck:tests`
Expected: all PASS (the erasure suites are unchanged in behaviour).

- [ ] **Step 6: Lint and commit**

```bash
pnpm exec biome check --write apps/server/app/db/sessionLock.ts apps/server/app/db/sessionLock.pg.test.ts apps/server/app/erasure/pgSteps.ts apps/server/app/erasure/eraser.ts
git add apps/server/app/db/sessionLock.ts apps/server/app/db/sessionLock.pg.test.ts apps/server/app/erasure/pgSteps.ts apps/server/app/erasure/eraser.ts
git commit -m "refactor(server): the erasure's session advisory lock is a shared helper

pgSessionLock(pool, key, label) is pgErasureLock's body with the key and the
log label as parameters, so the snapshot pruner can take one lock across
replicas the same way. The erasure's key and log text are unchanged.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The pruner core (sweep, interval runner, variable)

**Files:**
- Create: `apps/server/app/snapshots/pruner.ts`
- Test: `apps/server/app/snapshots/pruner.test.ts`

**Interfaces:**
- Consumes: `SessionLock` (Task 1); `isChatExecution(id: string): boolean` from `apps/server/app/chats/activity.ts`; `StartupConfigError` from `apps/server/app/startupError.ts`.
- Produces (all from `apps/server/app/snapshots/pruner.ts`):
  - `export const DEFAULT_SNAPSHOT_PRUNE_INTERVAL_MS = 3_600_000;`
  - `export function loadSnapshotPruneIntervalMs(env?: NodeJS.ProcessEnv): number`
  - `export interface SnapshotPruneDeps { listExecutionsPage(q: { cursor?: string; limit: number }): Promise<{ executionIds: string[]; nextCursor?: string }>; prune(executionId: string): Promise<number>; lock(): Promise<SessionLock | null>; }`
  - `export interface SweepReport { executions: number; deleted: number; failed: number; skipped: boolean; stopped: boolean; }`
  - `export async function sweepChatSnapshots(deps: SnapshotPruneDeps, signal?: AbortSignal, pageSize?: number): Promise<SweepReport>`
  - `export interface SnapshotPruner { stop(): Promise<void>; }`
  - `export function startSnapshotPruner(deps: SnapshotPruneDeps, everyMs: number): SnapshotPruner`

- [ ] **Step 1: Write the failing unit tests**

Create `apps/server/app/snapshots/pruner.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionLock } from "../db/sessionLock";
import { StartupConfigError } from "../startupError";
import {
  DEFAULT_SNAPSHOT_PRUNE_INTERVAL_MS,
  type SnapshotPruneDeps,
  loadSnapshotPruneIntervalMs,
  startSnapshotPruner,
  sweepChatSnapshots,
} from "./pruner";

const U = "11111111-1111-4111-8111-111111111111";
const C = "22222222-2222-4222-8222-222222222222";
const CHAT = `u_${U}.c-${C}`;
const CHAT_GEN2 = `${CHAT}~2`;
const INGEST = `u_${U}:ingest-33333333-3333-4333-8333-333333333333`;

function lockFake() {
  const release = vi.fn(async () => {}) as unknown as SessionLock & ReturnType<typeof vi.fn>;
  const lost = new AbortController();
  release.lost = lost.signal;
  return { release, lost };
}

function deps(ids: string[][], over: Partial<SnapshotPruneDeps> = {}) {
  const { release, lost } = lockFake();
  const pages = ids.map((executionIds, i) => ({
    executionIds,
    ...(i < ids.length - 1 && { nextCursor: `p${i + 1}` }),
  }));
  const d = {
    listExecutionsPage: vi.fn(async ({ cursor }: { cursor?: string }) => {
      const i = cursor === "u_" ? 0 : Number(String(cursor).slice(1));
      return pages[i] ?? { executionIds: [] };
    }),
    prune: vi.fn(async () => 2),
    lock: vi.fn(async () => release),
    ...over,
  };
  return { d, release, lost };
}

describe("loadSnapshotPruneIntervalMs", () => {
  it("defaults to an hour and reads 0 as off", () => {
    expect(loadSnapshotPruneIntervalMs({})).toBe(DEFAULT_SNAPSHOT_PRUNE_INTERVAL_MS);
    expect(DEFAULT_SNAPSHOT_PRUNE_INTERVAL_MS).toBe(3_600_000);
    expect(loadSnapshotPruneIntervalMs({ DOCMIND_SNAPSHOT_PRUNE_INTERVAL_MS: " 0 " })).toBe(0);
    expect(loadSnapshotPruneIntervalMs({ DOCMIND_SNAPSHOT_PRUNE_INTERVAL_MS: "60000" })).toBe(60_000);
    expect(loadSnapshotPruneIntervalMs({ DOCMIND_SNAPSHOT_PRUNE_INTERVAL_MS: "604800000" })).toBe(
      604_800_000,
    );
  });

  it.each(["-1", "1.5", "abc", "59999", "604800001", "1e6"])(
    "fails the boot on %s, naming the variable only",
    (value) => {
      const load = () => loadSnapshotPruneIntervalMs({ DOCMIND_SNAPSHOT_PRUNE_INTERVAL_MS: value });
      expect(load).toThrow(StartupConfigError);
      expect(load).toThrow(/DOCMIND_SNAPSHOT_PRUNE_INTERVAL_MS/);
      expect(() => load()).not.toThrow(new RegExp(`\\b${value.replace(/[.]/g, "\\.")}\\b`));
    },
  );
});

describe("sweepChatSnapshots", () => {
  it("prunes every chat conversation (every generation) and nothing else, from the u_ range only", async () => {
    const { d, release } = deps([[CHAT, INGEST], [CHAT_GEN2, "v_after-the-user-range", `u_${U}.c-late`]]);
    const report = await sweepChatSnapshots(d);
    expect(d.listExecutionsPage).toHaveBeenNthCalledWith(1, { cursor: "u_", limit: 500 });
    expect(d.prune.mock.calls.map(([id]) => id)).toEqual([CHAT, CHAT_GEN2]);
    expect(report).toEqual({ executions: 2, deleted: 4, failed: 0, skipped: false, stopped: false });
    expect(release).toHaveBeenCalledOnce();
  });

  it("does nothing when another replica holds the lock", async () => {
    const { d } = deps([[CHAT]], { lock: vi.fn(async () => null) });
    const report = await sweepChatSnapshots(d);
    expect(report.skipped).toBe(true);
    expect(d.listExecutionsPage).not.toHaveBeenCalled();
    expect(d.prune).not.toHaveBeenCalled();
  });

  it("counts a failure on one execution, logs its class only, and carries on", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const prune = vi
      .fn()
      .mockRejectedValueOnce(new RangeError(`secret ${CHAT}`))
      .mockResolvedValueOnce(3);
    const { d, release } = deps([[CHAT, CHAT_GEN2]], { prune });
    const report = await sweepChatSnapshots(d);
    expect(report).toMatchObject({ executions: 2, deleted: 3, failed: 1 });
    expect(JSON.stringify(error.mock.calls)).toContain("RangeError");
    expect(JSON.stringify(error.mock.calls)).not.toContain(U);
    expect(release).toHaveBeenCalledOnce();
    error.mockRestore();
  });

  it("stops before the next execution once aborted or once the lock is lost, and still releases", async () => {
    const stop = new AbortController();
    const { d, release } = deps([[CHAT, CHAT_GEN2]], {
      prune: vi.fn(async () => {
        stop.abort();
        return 1;
      }),
    });
    expect(await sweepChatSnapshots(d, stop.signal)).toMatchObject({ executions: 1, stopped: true });
    expect(release).toHaveBeenCalledOnce();

    const second = deps([[CHAT, CHAT_GEN2]]);
    second.d.prune = vi.fn(async () => {
      second.lost.abort();
      return 1;
    });
    expect(await sweepChatSnapshots(second.d)).toMatchObject({ executions: 1, stopped: true });
  });

  it("releases the lock when the listing throws, and rethrows", async () => {
    const { d, release } = deps([], {
      listExecutionsPage: vi.fn(async () => {
        throw new TypeError("down");
      }),
    });
    await expect(sweepChatSnapshots(d)).rejects.toThrow(TypeError);
    expect(release).toHaveBeenCalledOnce();
  });
});

describe("startSnapshotPruner", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("sweeps one interval after start, not at start, and logs counts only", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const { d } = deps([[CHAT]]);
    const pruner = startSnapshotPruner(d, 60_000);
    expect(d.lock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(d.prune).toHaveBeenCalledOnce();
    expect(info).toHaveBeenCalledWith(
      "snapshot prune",
      expect.objectContaining({ executions: 1, deleted: 2, failed: 0 }),
    );
    expect(JSON.stringify(info.mock.calls)).not.toContain(U);
    await pruner.stop();
    info.mockRestore();
  });

  it("never overlaps sweeps", async () => {
    let finish!: () => void;
    const { d } = deps([[CHAT]], {
      prune: vi.fn(() => new Promise<number>((r) => (finish = () => r(1)))),
    });
    const pruner = startSnapshotPruner(d, 60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(60_000); // a tick while the first sweep runs: skipped
    expect(d.lock).toHaveBeenCalledOnce();
    finish();
    await pruner.stop();
  });

  it("stop() waits for the sweep in progress and nothing runs afterwards", async () => {
    let finish!: () => void;
    let done = false;
    const { d } = deps([[CHAT, CHAT_GEN2]], {
      prune: vi.fn(
        () =>
          new Promise<number>((r) => {
            finish = () => r(1);
          }),
      ),
    });
    const pruner = startSnapshotPruner(d, 60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    const stopped = pruner.stop().then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(false);
    finish();
    await stopped;
    expect(d.prune).toHaveBeenCalledOnce(); // the abort stopped it before the second execution
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(d.lock).toHaveBeenCalledOnce();
  });

  it("logs a sweep that failed as a whole by class, and keeps the timer", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { d } = deps([], {
      listExecutionsPage: vi.fn(async () => {
        throw new TypeError(`down ${U}`);
      }),
    });
    const pruner = startSnapshotPruner(d, 60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(error).toHaveBeenCalledWith("snapshot prune failed", "TypeError");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(d.lock).toHaveBeenCalledTimes(2);
    await pruner.stop();
    error.mockRestore();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/server && pnpm exec vitest run app/snapshots/pruner.test.ts`
Expected: FAIL, `Failed to resolve import "./pruner"`.

- [ ] **Step 3: Implement `pruner.ts`**

Create `apps/server/app/snapshots/pruner.ts`:

```ts
import { isChatExecution } from "../chats/activity";
import type { SessionLock } from "../db/sessionLock";
import { StartupConfigError } from "../startupError";

export const DEFAULT_SNAPSHOT_PRUNE_INTERVAL_MS = 3_600_000;
const MIN_INTERVAL_MS = 60_000;
const MAX_INTERVAL_MS = 7 * 24 * 3_600_000;
/** User-owned execution ids all start with this; the log pages ids in code-point order, so they are one run. */
const USER_PREFIX = "u_";
const PAGE = 500;

/**
 * `DOCMIND_SNAPSHOT_PRUNE_INTERVAL_MS` (default an hour): how often the superseded snapshots of the chat
 * conversations are pruned. `0` turns the pruner off. A bad value fails the boot; the message names the
 * variable only.
 */
export function loadSnapshotPruneIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.DOCMIND_SNAPSHOT_PRUNE_INTERVAL_MS?.trim();
  if (!raw) return DEFAULT_SNAPSHOT_PRUNE_INTERVAL_MS;
  const value = Number(raw);
  const ok =
    /^\d+$/.test(raw) &&
    Number.isSafeInteger(value) &&
    (value === 0 || (value >= MIN_INTERVAL_MS && value <= MAX_INTERVAL_MS));
  if (!ok)
    throw new StartupConfigError(
      `DOCMIND_SNAPSHOT_PRUNE_INTERVAL_MS must be 0 (off) or an integer from ${MIN_INTERVAL_MS} to ${MAX_INTERVAL_MS}`,
    );
  return value;
}

/** What a sweep needs; `pgPruner.ts` binds it to Loom and Postgres. */
export interface SnapshotPruneDeps {
  listExecutionsPage(q: {
    cursor?: string;
    limit: number;
  }): Promise<{ executionIds: string[]; nextCursor?: string }>;
  /** Deletes the execution's superseded snapshots; resolves with how many. */
  prune(executionId: string): Promise<number>;
  /** The cross-replica lock of a sweep; null when another replica holds it. */
  lock(): Promise<SessionLock | null>;
}

/** Counts only, so it can be logged. */
export interface SweepReport {
  executions: number;
  deleted: number;
  failed: number;
  /** Another replica held the lock: nothing was looked at. */
  skipped: boolean;
  /** Aborted, or the lock was lost, before the last execution. */
  stopped: boolean;
}

const className = (err: unknown) => (err instanceof Error ? err.constructor.name : typeof err);

/**
 * One sweep: under the lock, page the `u_` executions and prune each chat conversation, one at a time. A failure
 * on one execution is counted and logged by class; the sweep carries on. A failed listing ends the sweep (rethrown).
 */
export async function sweepChatSnapshots(
  deps: SnapshotPruneDeps,
  signal?: AbortSignal,
  pageSize = PAGE,
): Promise<SweepReport> {
  const report: SweepReport = { executions: 0, deleted: 0, failed: 0, skipped: false, stopped: false };
  const release = await deps.lock();
  if (release === null) return { ...report, skipped: true };
  try {
    let cursor = USER_PREFIX; // strictly-after: every `u_…` id sorts after `u_`
    for (;;) {
      const page = await deps.listExecutionsPage({ cursor, limit: pageSize });
      for (const executionId of page.executionIds) {
        if (!executionId.startsWith(USER_PREFIX)) return report; // past the user range
        if (!isChatExecution(executionId)) continue;
        if (signal?.aborted || release.lost?.aborted) {
          report.stopped = true;
          return report;
        }
        report.executions += 1;
        try {
          report.deleted += await deps.prune(executionId);
        } catch (err) {
          report.failed += 1;
          console.error("snapshot prune failed for one execution", className(err));
        }
      }
      if (page.nextCursor === undefined) return report;
      cursor = page.nextCursor;
    }
  } finally {
    await release();
  }
}

export interface SnapshotPruner {
  /** Stops the timer and resolves once a sweep in progress has finished its current execution. */
  stop(): Promise<void>;
}

/** One sweep per `everyMs`, the first one interval after start; a tick during a sweep is skipped. Unref'd. */
export function startSnapshotPruner(deps: SnapshotPruneDeps, everyMs: number): SnapshotPruner {
  const stopping = new AbortController();
  let running: Promise<unknown> | null = null;
  const tick = () => {
    if (running !== null || stopping.signal.aborted) return;
    const started = Date.now();
    running = sweepChatSnapshots(deps, stopping.signal)
      .then((r) => {
        if (r.skipped) console.info("snapshot prune skipped: another replica holds the lock");
        else
          console.info("snapshot prune", {
            executions: r.executions,
            deleted: r.deleted,
            failed: r.failed,
            stopped: r.stopped,
            ms: Date.now() - started,
          });
      })
      .catch((err: unknown) => console.error("snapshot prune failed", className(err)))
      .finally(() => {
        running = null;
      });
  };
  const timer = setInterval(tick, everyMs);
  timer.unref();
  return {
    async stop() {
      clearInterval(timer);
      stopping.abort();
      await running;
    },
  };
}
```

- [ ] **Step 4: Run the unit tests**

Run: `cd apps/server && pnpm exec vitest run app/snapshots/pruner.test.ts`
Expected: PASS (all). If the "never names the value" assertion is awkward for `"0"`-like inputs, keep the `.each` list as written: none of those values appears in the message.

- [ ] **Step 5: Lint, typecheck, commit**

```bash
pnpm exec biome check --write apps/server/app/snapshots
(cd apps/server && pnpm typecheck && pnpm typecheck:tests)
git add apps/server/app/snapshots/pruner.ts apps/server/app/snapshots/pruner.test.ts
git commit -m "feat(server): a sweep that prunes the chat conversations' snapshots, on an interval

sweepChatSnapshots pages the u_ executions under a cross-replica lock and
prunes each chat conversation (every generation) one at a time; a failure
on one is counted and logged by class. startSnapshotPruner runs it once per
DOCMIND_SNAPSHOT_PRUNE_INTERVAL_MS (default an hour, 0 off), the first time
one interval after start, never overlapping, and stop() waits for it.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Bind it to Loom and prove it on real chats

**Files:**
- Create: `apps/server/app/snapshots/pgPruner.ts`
- Test: `apps/server/app/snapshots/prune.e2e.pg.test.ts`

**Interfaces:**
- Consumes: `SnapshotPruneDeps`, `sweepChatSnapshots` (Task 2); `pgSessionLock` (Task 1); `DurableStorage` from `apps/server/app/storage.ts` (`raw.eventStore`, `raw.snapshotStore`, `pool`); `LogLifecycle` from `@loom/workflow-runtime`.
- Produces: `export const SNAPSHOT_PRUNE_LOCK_KEY = "docmind:snapshot-prune";` and `export function snapshotPruneDeps(durable: Pick<DurableStorage, "raw" | "pool">): SnapshotPruneDeps` from `apps/server/app/snapshots/pgPruner.ts`.

- [ ] **Step 1: Write the failing acceptance test**

Create `apps/server/app/snapshots/prune.e2e.pg.test.ts`. It reuses the chat acceptance helpers (`scriptChat`, `collectUntil`, `isReply`, `DOC` in `chats/e2eSupport.ts`) and the erasure helpers (`eraseMe`, `waitErased` in `erasure/e2eSupport.ts`):

```ts
import { rmSync } from "node:fs";
import { ChatSessionDto, type UploadDocumentResponse } from "@docmind/contracts";
import { afterAll, describe, expect, it } from "vitest";
import { chatConversationId } from "../chats/ids";
import { DOC, collectUntil, isReply, scriptChat } from "../chats/e2eSupport";
import { pgSessionLock } from "../db/sessionLock";
import { PG_URL } from "../db/testSupport";
import { type IngestStack, startIngestStack } from "../documents/ingestStack";
import { eraseMe, waitErased } from "../erasure/e2eSupport";
import { SNAPSHOT_PRUNE_LOCK_KEY, snapshotPruneDeps } from "./pgPruner";
import { sweepChatSnapshots } from "./pruner";

describe.skipIf(!PG_URL)("snapshot pruning on real chats (needs DOCMIND_TEST_PG_URL)", () => {
  const stacks: IngestStack[] = [];
  const dbs = new Set<IngestStack["db"]>();
  const roots = new Set<string>();
  const track = (stack: IngestStack) => {
    stacks.push(stack);
    dbs.add(stack.db);
    roots.add(stack.root);
    return stack;
  };
  afterAll(async () => {
    for (const s of stacks.splice(0)) await s.close({ keepDb: true });
    for (const db of dbs) await db.drop();
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  const snapshots = async (st: IngestStack, executionId: string) =>
    (
      await st.db.owner.query(
        "SELECT sequence, md5(state::text) AS h FROM loom.snapshots WHERE execution_id = $1 ORDER BY sequence",
        [executionId],
      )
    ).rows as { sequence: string; h: string }[];

  /** One user, one ready document, one chat answered `turns` times; returns the conversation id. */
  async function chatTurns(st: IngestStack, email: string, turns: number) {
    const claude = st.claude;
    if (!claude) throw new Error("no fake Claude");
    const user = await st.signUpAndLogIn(email);
    const events = await st.events(user.cookie);
    const up = await st.upload(user.cookie, "terms.txt", Buffer.from(DOC));
    const documentId = ((await up.json()) as UploadDocumentResponse).document.id;
    await st.until(events, documentId, (s) => s === "ready" || s === "failed");
    events.close();
    scriptChat(claude, () => ({
      stream: { steps: [{ text: "Due in 30 days." }, { stop: "end_turn" }] },
    }));
    const chat = ChatSessionDto.parse(
      await (await st.chatReq(user.cookie, "POST", "/api/chats", {})).json(),
    );
    const stream = await st.openChat(user.cookie, chat.id);
    try {
      for (let i = 0; i < turns; i++) {
        const sent = await st.chatReq(user.cookie, "POST", `/api/chats/${chat.id}/messages`, {
          text: `Question ${i}: when is payment due?`,
        });
        expect(sent.status).toBe(202);
        // every reply so far, this turn's included
        await collectUntil(stream, (f) => isReply(f) && JSON.stringify(f.data).includes("30 days"), i + 1);
      }
    } finally {
      stream.close();
    }
    return { user, chat, conversation: chatConversationId(user.userId, chat.id) as string };
  }

  it("keeps the latest snapshot of a chat, deletes the rest, and the chat answers after a restart", async () => {
    const first = track(await startIngestStack({ chat: true }));
    const ada = await chatTurns(first, "ada@example.com", 3);
    const before = await snapshots(first, ada.conversation);
    expect(before.length).toBeGreaterThan(1);
    const ingestBefore = (
      await first.db.owner.query(
        "SELECT execution_id, count(*)::int AS n FROM loom.snapshots WHERE execution_id NOT LIKE '%.c-%' GROUP BY 1 ORDER BY 1",
      )
    ).rows;

    // Another replica holds the lock: the sweep looks at nothing.
    const held = await pgSessionLock(first.durable.pool, SNAPSHOT_PRUNE_LOCK_KEY, "test");
    expect(held).not.toBeNull();
    expect(await sweepChatSnapshots(snapshotPruneDeps(first.durable))).toMatchObject({
      skipped: true,
      deleted: 0,
    });
    await held?.();
    expect(await snapshots(first, ada.conversation)).toEqual(before);

    const report = await sweepChatSnapshots(snapshotPruneDeps(first.durable));
    expect(report).toMatchObject({ skipped: false, failed: 0, deleted: before.length - 1 });
    expect(await snapshots(first, ada.conversation)).toEqual([before.at(-1)]);
    // nothing else changed: ingest executions keep theirs
    expect(
      (
        await first.db.owner.query(
          "SELECT execution_id, count(*)::int AS n FROM loom.snapshots WHERE execution_id NOT LIKE '%.c-%' GROUP BY 1 ORDER BY 1",
        )
      ).rows,
    ).toEqual(ingestBefore);
    // a second sweep has nothing left to do
    expect(await sweepChatSnapshots(snapshotPruneDeps(first.durable))).toMatchObject({ deleted: 0 });

    // The chat resumes from the one snapshot left: a restart, then another turn, with the history intact.
    await first.close({ keepDb: true });
    stacks.splice(stacks.indexOf(first), 1);
    const second = track(
      await startIngestStack({
        chat: true,
        resume: { db: first.db, kek: first.kek, root: first.root },
      }),
    );
    const claude2 = second.claude;
    if (!claude2) throw new Error("no fake Claude");
    scriptChat(claude2, () => ({
      stream: { steps: [{ text: "Two percent per month." }, { stop: "end_turn" }] },
    }));
    const stream = await second.openChat(ada.user.cookie, ada.chat.id);
    try {
      const sent = await second.chatReq(ada.user.cookie, "POST", `/api/chats/${ada.chat.id}/messages`, {
        text: "And late payment?",
      });
      expect(sent.status).toBe(202);
      const frames = await collectUntil(
        stream,
        (f) => isReply(f) && JSON.stringify(f.data).includes("Two percent"),
      );
      expect(JSON.stringify(frames)).toContain("Two percent per month.");
    } finally {
      stream.close();
    }
    // the model saw the earlier turns: the restored state carried them
    const lastRequest = JSON.stringify(claude2.requests.at(-1)?.body);
    expect(lastRequest).toContain("Question 2: when is payment due?");
  });

  it("prunes an erased user's chat without opening it", async () => {
    const st = track(await startIngestStack({ chat: true }));
    const bob = await chatTurns(st, "bob@example.com", 2);
    expect((await snapshots(st, bob.conversation)).length).toBeGreaterThan(1);
    expect((await eraseMe(st, bob.user.cookie)).status).toBe(202);
    await waitErased(st, bob.user.userId);
    const left = await snapshots(st, bob.conversation);
    const report = await sweepChatSnapshots(snapshotPruneDeps(st.durable));
    expect(report.failed).toBe(0);
    expect((await snapshots(st, bob.conversation)).length).toBe(Math.min(left.length, 1));
  });
});
```

Before running: check `collectUntil`'s signature in `apps/server/app/chats/e2eSupport.ts:31` and adapt the two calls if it takes no third argument (then wait for the reply whose text matches, turn by turn, as `restart.e2e.pg.test.ts` does). Check that the fake Anthropic exposes the requests it received (`claude2.requests`; `chats/e2eSupport.ts` exports `hasToolResult(body: FakeRequest["body"])`, so the fake records bodies; use the field name it actually has).

- [ ] **Step 2: Run it to verify it fails**

Run: `set -a; . ./.env; set +a; cd apps/server && pnpm exec vitest run app/snapshots/prune.e2e.pg.test.ts`
Expected: FAIL, `Failed to resolve import "./pgPruner"`.

- [ ] **Step 3: Implement `pgPruner.ts`**

Create `apps/server/app/snapshots/pgPruner.ts`:

```ts
import { LogLifecycle } from "@loom/workflow-runtime";
import { pgSessionLock } from "../db/sessionLock";
import type { DurableStorage } from "../storage";
import type { SnapshotPruneDeps } from "./pruner";

/** The session advisory lock one sweep holds, on the Loom database (ADR 0134 D6: one pruner per execution). */
export const SNAPSHOT_PRUNE_LOCK_KEY = "docmind:snapshot-prune";

/**
 * The production pruner: Loom's `LogLifecycle.pruneSnapshots(id, { keepLatest: 1 })` over the RAW stores, which
 * reads the log's structure and deletes snapshot rows by sequence without opening a sealed payload or state.
 *
 * This lifecycle has NO `compactionExempt`, on purpose: the app's (config.ts) exempts the ingest and chat
 * executions from COMPACTION (the read models fold their logs from the first event; a conversation parks on its
 * inbox), and Loom's `pruneSnapshots` treats an exempt execution as held. Pruning snapshots removes no event, so
 * neither reason applies, and Loom still never deletes the latest snapshot, a compacted log's checkpoint or a
 * fork point. The app's exemption, and so the refusal to compact, is unchanged.
 */
export function snapshotPruneDeps(durable: Pick<DurableStorage, "raw" | "pool">): SnapshotPruneDeps {
  const { eventStore, snapshotStore } = durable.raw;
  const list = eventStore.listExecutionsPage?.bind(eventStore);
  if (list === undefined)
    throw new TypeError("snapshot pruning: the event store cannot list executions");
  const lifecycle = new LogLifecycle(eventStore, snapshotStore, {});
  return {
    listExecutionsPage: (q) => list(q),
    prune: (executionId) => lifecycle.pruneSnapshots(executionId, { keepLatest: 1 }),
    lock: () => pgSessionLock(durable.pool, SNAPSHOT_PRUNE_LOCK_KEY, "snapshot prune lock"),
  };
}
```

If `tsc` rejects `eventStore`/`snapshotStore` for `LogLifecycle` (the custom storage types are wider than Loom's `EventStore`), pass them `as never`, the cast `storage.ts:71` already uses for the same reason, with that comment. If `listExecutionsPage`'s parameter or result type differs from `SnapshotPruneDeps` (for example `nextCursor: string | null`), map it in this adapter, never in `pruner.ts`.

- [ ] **Step 4: Run the acceptance test until it passes**

Run: `set -a; . ./.env; set +a; cd apps/server && pnpm exec vitest run app/snapshots/prune.e2e.pg.test.ts`
Expected: PASS, both tests. If `deleted` is not `before.length - 1`, read `LogLifecycle.pruneSnapshots`'s doc comment (`../loom/packages/workflow-runtime/src/LogLifecycle.ts`, around line 1660) before changing the assertion: the only legitimate keeps are the ones it lists.

- [ ] **Step 5: Lint, typecheck, commit**

```bash
pnpm exec biome check --write apps/server/app/snapshots
(cd apps/server && pnpm typecheck && pnpm typecheck:tests)
git add apps/server/app/snapshots/pgPruner.ts apps/server/app/snapshots/prune.e2e.pg.test.ts
git commit -m "feat(server): prune chat snapshots with Loom's LogLifecycle on the raw stores

snapshotPruneDeps binds the sweep to LogLifecycle.pruneSnapshots with
keepLatest 1, on a lifecycle without compactionExempt (that exemption is
about compaction; pruning removes no event), and a session advisory lock on
the Loom pool. Proven on real chats: the latest snapshot stays, a restart
resumes from it, ingest is untouched, a held lock skips the sweep, and an
erased user's chat is pruned without opening it.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Start it with the server and drain it at shutdown

**Files:**
- Modify: `apps/server/app/bootIngest.ts` (the `BootIngestParts` interface, the destructuring, `afterListen`, `stop`)
- Modify: `apps/server/app/setup.ts:61` and its return value at `setup.ts:155`
- Modify: `apps/server/app/main.ts:22-35`
- Modify: `apps/server/app/documents/ingestStack.ts` (`IngestStackOptions` and the `bootIngest({...})` call at line ~183)
- Test: `apps/server/app/snapshots/prune.e2e.pg.test.ts` (one more test)

**Interfaces:**
- Consumes: `startSnapshotPruner`, `loadSnapshotPruneIntervalMs` (Task 2); `snapshotPruneDeps` (Task 3).
- Produces: `BootIngestParts.snapshotPruneIntervalMs?: number` (default `0`: off, so scripts and the existing acceptance stacks are unchanged); `IngestStackOptions.snapshotPruneIntervalMs?: number`; `setupServer()` returns `snapshotPruneIntervalMs`.

- [ ] **Step 1: Write the failing wiring test**

Append to the `describe` in `apps/server/app/snapshots/prune.e2e.pg.test.ts`:

```ts
  it("runs on its interval inside the server and stops with it", async () => {
    const st = track(await startIngestStack({ chat: true, snapshotPruneIntervalMs: 300 }));
    const cy = await chatTurns(st, "cy@example.com", 3);
    await expect
      .poll(async () => (await snapshots(st, cy.conversation)).length, { timeout: 15_000, interval: 100 })
      .toBe(1);
    await st.close({ keepDb: true }); // stop() drains the pruner with the upload sweeper; no unhandled rejection
    stacks.splice(stacks.indexOf(st), 1);
  });
```

Note: 300 ms is below the variable's 60 s minimum on purpose: the minimum guards the operator's setting (`loadSnapshotPruneIntervalMs`); `bootIngest` and the stack take any positive interval.

- [ ] **Step 2: Run it to verify it fails**

Run: `set -a; . ./.env; set +a; cd apps/server && pnpm exec vitest run app/snapshots/prune.e2e.pg.test.ts -t "runs on its interval"`
Expected: FAIL, a type error on `snapshotPruneIntervalMs` (or, under esbuild, the poll times out with 3+ snapshots).

- [ ] **Step 3: Wire `bootIngest`**

In `apps/server/app/bootIngest.ts`:

1. Imports:

```ts
import { snapshotPruneDeps } from "./snapshots/pgPruner";
import { startSnapshotPruner } from "./snapshots/pruner";
```

2. In `BootIngestParts`, after `shutdownDelayMs?: number;`:

```ts
  /**
   * How often to prune the chat conversations' superseded snapshots (`DOCMIND_SNAPSHOT_PRUNE_INTERVAL_MS`,
   * loaded by `setupServer`). Default 0: off, so a script or a test stack that does not ask runs no pruner.
   * Only with `background`.
   */
  snapshotPruneIntervalMs?: number;
```

3. In the destructuring of `parts`, add `snapshotPruneIntervalMs = 0,` after `shutdownDelayMs = 0,`.

4. Next to `let uploadSweeper: …`, add:

```ts
  let snapshotPruner: ReturnType<typeof startSnapshotPruner> | undefined;
```

5. At the end of `afterListen`, after the `uploadSweeper = startSweeper({...});` statement:

```ts
    // The first sweep runs one interval from now, never during the boot (recovery and the index come first).
    if (snapshotPruneIntervalMs > 0)
      snapshotPruner = startSnapshotPruner(snapshotPruneDeps(durable), snapshotPruneIntervalMs);
```

6. In `stop`, replace

```ts
      const sweeperStopped = uploadSweeper?.stop() ?? Promise.resolve(); // idempotent; no sweep may fire a start once the drain begins
```

with

```ts
      const sweeperStopped = uploadSweeper?.stop() ?? Promise.resolve(); // idempotent; no sweep may fire a start once the drain begins
      // A prune in progress finishes its current execution (one DELETE) and releases its lock connection to the
      // Loom pool, which closes later; it shares the sweeper's drain bound, so the deadline is unchanged.
      const prunerStopped = snapshotPruner?.stop() ?? Promise.resolve();
```

and in `close`, replace

```ts
        await drainWithin(sweeperStopped, SHUTDOWN_DRAIN_MS);
```

with

```ts
        await drainWithin(Promise.all([sweeperStopped, prunerStopped]), SHUTDOWN_DRAIN_MS);
```

Also update the `stop` comment "then timers" and the doc comment above `bootIngest` ("recovery, the session sweep and the upload sweeper") to name the snapshot pruner.

- [ ] **Step 4: Load the variable in `setupServer` and pass it in `main`**

In `apps/server/app/setup.ts`, next to line 61 (`const shutdownDelayMs = loadShutdownDelayMs(...)`):

```ts
  const snapshotPruneIntervalMs = loadSnapshotPruneIntervalMs(env);
```

with `import { loadSnapshotPruneIntervalMs } from "./snapshots/pruner";`, and add `snapshotPruneIntervalMs` to the returned object at line 155. Load it with the other variables, BEFORE any pool or store is opened, so a bad value fails the boot without cleanup (check where `shutdownDelayMs` sits and keep it beside it).

In `apps/server/app/main.ts`, add `snapshotPruneIntervalMs` to the destructuring of `await setupServer()` (line 22) and pass `snapshotPruneIntervalMs,` to `bootIngest({...})` after `shutdownDelayMs,`.

- [ ] **Step 5: Pass it through the acceptance stack**

In `apps/server/app/documents/ingestStack.ts`, add to `IngestStackOptions`:

```ts
  /** Runs the snapshot pruner every this many ms (the production default is an hour; omitted: off). */
  snapshotPruneIntervalMs?: number;
```

and to the `bootIngest({...})` call:

```ts
      ...(options.snapshotPruneIntervalMs !== undefined && {
        snapshotPruneIntervalMs: options.snapshotPruneIntervalMs,
      }),
```

- [ ] **Step 6: Run the wiring test, the shutdown tests and the setup tests**

Run: `set -a; . ./.env; set +a; cd apps/server && pnpm exec vitest run app/snapshots app/closeSequence.test.ts app/shutdown.test.ts app/setup && pnpm typecheck && pnpm typecheck:tests`
Expected: PASS. (If there is no `app/setup*` test, the path filter simply matches nothing; that is fine.)

- [ ] **Step 7: Lint and commit**

```bash
pnpm exec biome check --write apps/server/app
git add apps/server/app/bootIngest.ts apps/server/app/setup.ts apps/server/app/main.ts apps/server/app/documents/ingestStack.ts apps/server/app/snapshots/prune.e2e.pg.test.ts
git commit -m "feat(server): run the snapshot pruner with the server

setupServer loads DOCMIND_SNAPSHOT_PRUNE_INTERVAL_MS; bootIngest starts the
pruner after listen (first sweep one interval later) and drains it with the
upload sweeper at shutdown, inside the same bound, so the shutdown deadline
is unchanged. Off unless asked, for scripts and the test stacks.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Document it, and run the whole gate

**Files:**
- Modify: `.env.example` (near the `DOCMIND_SHUTDOWN_DELAY_MS` block, line ~83)
- Modify: `docs/operations/cloud-deploy.md` (the server variables section; find it with `grep -n "DOCMIND_SHUTDOWN_DEADLINE_MS" docs/operations/cloud-deploy.md`)
- Modify: `docs/architecture.md` (the crypto-shredding / storage bullets, line ~145)
- Modify: `docs/design/cloud-scaling.md` (where snapshots or storage growth are discussed; `grep -n -i "snapshot" docs/design/cloud-scaling.md`)
- Modify: `docs/specs/2026-11-03-snapshot-pruning-design.md` (the "Shutdown" section)

- [ ] **Step 1: `.env.example`**

Add, in the same commented style as its neighbours:

```bash
# How often the superseded snapshots of chat conversations are deleted (the latest of each is kept), in ms.
# One replica sweeps at a time (an advisory lock). 0 turns it off; otherwise 60000 to 604800000. Default: an hour.
# DOCMIND_SNAPSHOT_PRUNE_INTERVAL_MS=3600000
```

- [ ] **Step 2: `docs/operations/cloud-deploy.md`**

In the variables list or table that holds `DOCMIND_SHUTDOWN_DEADLINE_MS`, add a row/bullet in the same format:

`DOCMIND_SNAPSHOT_PRUNE_INTERVAL_MS` — default `3600000`. Each chat conversation writes a snapshot of its whole state every turn; the pruner keeps the latest and deletes the rest (Loom `LogLifecycle.pruneSnapshots`, `keepLatest: 1`). Measured on a dev database: 91% of `loom.snapshots` was superseded. Replicas take turns through a Postgres advisory lock, so every replica can keep the default. `0` turns it off. Deleted rows are reclaimed by autovacuum; run `VACUUM (ANALYZE) loom.snapshots` once after the first sweep on a large existing database if you want the disk space back sooner (plain `VACUUM` makes the space reusable; only `VACUUM FULL` returns it to the OS, and it locks the table).

- [ ] **Step 3: `docs/architecture.md`**

After the crypto-shredding bullet (line ~145), add:

`- **Snapshot pruning.** A chat parks after every turn and Loom snapshots its whole state each time; an hourly sweep (one replica at a time) keeps each conversation's latest snapshot and deletes the rest. It runs on the raw stores, so it never needs a user's key. Compaction stays off for chats and ingest (`compactionExempt`).`

- [ ] **Step 4: `docs/design/cloud-scaling.md`**

Where storage growth is discussed (or at the end of the storage section if there is none), add the measurement and the bound:

`Snapshots, not events, dominate the Loom database: on a dev database \`loom.snapshots\` was 657 MB against 86 MB of \`loom.events\` (206 chats, up to 51 snapshots each, the largest 3 MB), and 91% of it was superseded. Since the snapshot pruner (\`DOCMIND_SNAPSHOT_PRUNE_INTERVAL_MS\`), snapshot storage is about one snapshot per conversation generation, so it grows with the number of chats, not with turns × state size.`

- [ ] **Step 5: Bring the spec in line with what was built**

In `docs/specs/2026-11-03-snapshot-pruning-design.md`, replace the "### Shutdown" section's body with:

`bootIngest`'s `stop()` stops the pruner with the upload sweeper: the timer is cleared, a sweep in progress finishes its current execution (one DELETE) and releases its lock connection back to the Loom pool, and both are drained together inside the existing `SHUTDOWN_DRAIN_MS` bound before the close sequence runs. The close sequence and the forced-exit deadline are unchanged.

and in "### When", replace "at least ... fails the boot with a named error" wording so it states: `0` disables; otherwise 60,000 to 604,800,000; anything else fails the boot with a `StartupConfigError` naming the variable only. In "## Testing", replace "`closeSequence.test.ts`: the new step's order and bound." with "The wiring: a stack with a short interval prunes a chat down to one snapshot on its own and shuts down cleanly."

- [ ] **Step 6: Run the whole gate**

Run, from the repo root:

```bash
set -a; . ./.env; set +a
pnpm build && pnpm lint && pnpm typecheck && pnpm typecheck:tests && pnpm test
```

Expected: every step exits 0; `@docmind/server` reports 0 failed and no "Unhandled Errors" block (grep the output for `Unhandled` and `Errors  ` to be sure).

- [ ] **Step 7: Commit**

```bash
git add .env.example docs/operations/cloud-deploy.md docs/architecture.md docs/design/cloud-scaling.md docs/specs/2026-11-03-snapshot-pruning-design.md
git commit -m "docs: the snapshot pruner, its variable and the storage it saves

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
