# Snapshot pruning: design

Date: 2026-11-03. Status: approved in conversation, awaiting spec review.
Loom: `252cf914` (ADR 0134 snapshot pruning and its amendment, ADR 0145 retention policy).

## Problem

Loom keeps every snapshot an execution takes until the whole execution is deleted. A DocMind chat
parks on its inbox after every turn, and every park writes a snapshot of the whole conversation state,
so a chat that runs 50 turns before it rotates keeps 50 snapshots, each larger than the last.

Measured on a local dev database (2026-11-03):

| | |
|---|---|
| `loom.snapshots` | 657 MB (the event log, `loom.events`, is 86 MB) |
| snapshots / executions | 1,808 / 206, every one a chat conversation |
| most snapshots on one execution | 51 |
| largest snapshot | 3 MB |
| superseded (not the latest of its execution) | 573 MB, 91% |

Only the latest snapshot is ever read: a resume folds on it. The older ones serve fork points and
compaction checkpoints, and DocMind uses neither.

## Goal

Keep the latest snapshot of each chat conversation and delete the rest, on a schedule, on every
deployment, without changing what any read, resume or erasure sees.

Not goals: deleting terminal executions (log retention, ADR 0145 `terminalTtlMs`), compaction,
snapshot compression (ADR 0136/0141).

## Design

### Who decides what is safe: Loom's `LogLifecycle.pruneSnapshots`

`LogLifecycle.pruneSnapshots(executionId, { keepLatest: 1 })` decides from the log what can go and
deletes it in one statement. It never deletes the latest `keepLatest` snapshots, a compacted log's
checkpoint or anything below it (the fork points of ADR 0107), or a log compacted through its tip.
DocMind does not reimplement any of that.

### Its own `LogLifecycle`, without `compactionExempt`

`pruneSnapshots` returns 0 for an execution `compactionExempt` names ("a hold also holds its
snapshots"), and `config.ts` exempts every ingest and chat execution. The exemption exists for
compaction only:

- the status and activity read models fold each ingest and chat execution's log from its first
  event, so its prefix must never be removed (ADR 0132);
- a conversation parks on its inbox, and a log compacted through its tip behind a whole-state sealed
  checkpoint would read as terminal to the erasure coordinator.

Pruning snapshots removes no event, so neither reason applies to it. The pruner therefore builds its
own `new LogLifecycle(raw.eventStore, raw.snapshotStore)` with no `compactionExempt`. The app's
`durability.retention.compactionExempt` stays exactly as it is, so compaction is still refused for
these executions, and `retention.test.ts` (nothing calls `compact`) still holds.

It runs on the RAW stores (`DurableStorage.raw`): it reads the log's structure (sequences, gaps) and
deletes snapshot rows by sequence, and never opens a sealed payload or state. So it needs no key and
works the same on an execution whose user has been erased.

### Which executions

Every chat conversation, of every generation (`chatIdOfConversation` matches `…~<n>`): it pages the
event store's `listExecutionsPage` from the `u_` prefix, as `hydrateSubjectIndex` does, and keeps the
ids `isChatExecution` accepts. Ingest runs end after one document and take a handful of snapshots, so
they are left alone (YAGNI); widening the filter later is a one-line change.

Executions are pruned one at a time, sequentially: a sweep is background work and must not compete
with chat turns for the Loom pool.

### When: one sweep per interval, one replica at a time

- `DOCMIND_SNAPSHOT_PRUNE_INTERVAL_MS`, default 3,600,000 (1 h); `0` disables the pruner. Parsed like
  the other server variables (a non-integer or negative value fails the boot with a named error).
- The first sweep starts one interval after boot, never during it, so it never competes with recovery
  and `bootIngest`.
- ADR 0134 D6: two processes must not prune (or compact) one execution at once. Each sweep first takes
  a session advisory lock (`pg_try_advisory_lock` on a fixed DocMind key) on one connection borrowed
  from the Loom pool, holds it for the sweep and releases it after. A replica that does not get the
  lock skips that sweep. If the lock's connection fails, the sweep stops at the next execution.
- A conversation that saves a new snapshot while it is being pruned is safe: Loom decides from reads
  taken before the delete and only ever deletes below the `keepLatest`-th newest, and a new snapshot
  is always above it.
- The interval timer is `unref`'d.

### Shutdown

`closeSequence` gains `stopPruner` before the eraser stops: it stops the timer and waits for the
current execution's prune to finish (one DELETE), bounded by `POOL_END_MS`, then releases the lock.
The lock connection goes back to the Loom pool before `endPool`. The forced-exit deadline counts this
bound the way `ce1ec3e` counts the eraser's drain.

### Observability

One log line per sweep, ids-free: `snapshot prune: <n> executions, <m> snapshots deleted, <ms> ms`,
plus `skipped (another replica holds the lock)`. An error on one execution is logged by class name only
(the message can carry an execution id) and the sweep carries on with the next; an error that ends the
sweep (the listing failed, the lock connection was lost) is logged the same way.

### Configuration and docs

- `.env.example`, `docs/operations/cloud-deploy.md` (variables table) and `docs/architecture.md`
  (one line under storage) document the variable and what the sweep keeps.
- `docs/design/cloud-scaling.md`: the snapshot growth figure and the fact that it is now bounded.

## Testing

- **Unit** (`SnapshotPruner`, fakes for the lifecycle, the listing and the lock): only chat ids are
  pruned; `keepLatest: 1` is passed; a failure on one execution does not end the sweep; no lock, no
  sweep; `stop()` waits for the in-flight prune and no sweep starts after it; `0` disables it; the env
  parser rejects bad values.
- **Postgres e2e** (`snapshotPrune.e2e.pg.test.ts`, real stores, sealed): a chat of N turns has N
  snapshots; after a sweep it has 1 (the latest, unchanged); the server restarts and the chat answers
  another turn with its history intact; a second sweep deletes 0; two pruners racing on two
  connections delete each snapshot once and the loser reports `skipped`; an ingest execution's
  snapshots are untouched; an erased user's chat can be pruned and stays unreadable (the erasure
  residue scan, `e2eSupport.ts`, still passes).
- `closeSequence.test.ts`: the new step's order and bound.

## Decided not to adopt: claim-checking tool outputs (ADR 0140/0143)

`execution.claimCheck` replaces a listed tool's result with a digest or preview, both in the log and
in what the model sees. DocMind's tools are the retrieval the answer is grounded on (`search_docs`,
`read_section`, `related`); withholding their text from the model would break grounded answers. The
saving would also be small: tool outputs averaged 663 bytes, the largest was 18 kB, and only 67 were
over 1.5 kB (212 kB in all) on the same database. Revisit only if tool outputs grow by orders of
magnitude, and then only for tools whose output the model does not need in full.

## Follow-up (separate spec)

The rolling conversation summarizer (`createSummarizerEffect` as `budget.summarizerToolId`,
ADR 0137), approved in the same conversation.
