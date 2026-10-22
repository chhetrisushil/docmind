# Backfilling ingestion for old documents

The periodic upload sweep only looks back 7 days. A document uploaded before that, which never got an
ingest flow (an M2-era upload), is never started by it. This command starts those.

## 1. Stop the server first

**Stop every server instance before you run this.** The backfill runs its own flow engine and its own
recovery pass against the database, and the design allows exactly one server or flow-engine process per
database (spec 5.2). Running it beside a live server risks two engines driving the same execution.
Start the server again after the command exits.

## 2. Run

Build, then set the same environment as the server (`DATABASE_URL`, `LOOM_DATABASE_URL`, the KEK, the
`DOCMIND_*`, `GEMINI_API_KEY` and `ANTHROPIC_API_KEY` variables (without `GEMINI_API_KEY` a backfill runs with `vision_pdf` off and scanned PDFs fail as `vision_unavailable`), and also `PORT`, `HOST`, `DOCMIND_PUBLIC_ORIGIN` and the
rest: the command binds no port, but it shares the server's configuration checks):

```sh
pnpm --filter @docmind/server build
pnpm --filter @docmind/server backfill:ingest -- --days 90
```

- `--days N` is required: an integer from 1 to 400 (the SQL function clamps there).
- By default the command waits until the executions it started have finished, and also for the recovery
  pass that ran at boot. Executions that recovery resumed are not tracked beyond that pass. With
  `--no-wait` it stops as soon as the starts have landed: executions still running are interrupted and
  re-driven at the next server boot, and each such interruption spends one of the execution's recovery
  attempts (the bound is 3), so prefer waiting for large backfills.
- It binds no port and runs no periodic sweeps. Recovery runs, so other abandoned executions are also resumed.
- Safe to repeat: a document with a status row for its current generation is not selected, and starts
  are once-only per execution. Documents are taken in batches of 100.
- SIGINT or SIGTERM stops it cleanly (exit 1).
- Logs are counts only: `started`, `alreadyRunning`, `failedStarts`, and executions `completed` / `failed`.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Every selected document was handed to the flow engine; no start failed. |
| 1 | A failure: the sweep query failed, a start failed, shutdown failed, or it was interrupted. The class is logged. Run again. |
| 2 | Bad arguments (`--days must be an integer from 1 to 400`). |
| 3 | Incomplete: a full batch kept coming back with nothing new (status rows lagging). Run it again. |

Documents whose execution ran and failed are not an exit-code failure; they show as `failed` in the app.
