# Backfilling ingestion for old documents

The periodic upload sweep only looks back 7 days. A document uploaded before that, which never got an
ingest flow (an M2-era upload), is never started by it. This command starts those.

## Run

Build, set the same environment as the server (`DATABASE_URL`, `LOOM_DATABASE_URL`, the KEK, the
`DOCMIND_*` and `ANTHROPIC_API_KEY` variables), then:

```sh
pnpm --filter @docmind/server build
pnpm --filter @docmind/server backfill:ingest -- --days 90
```

- `--days N` is required: an integer from 1 to 400 (the SQL function clamps there). A bad value exits 2
  with `--days must be an integer from 1 to 400`.
- By default the command waits for every execution it started to finish before it exits.
  `--no-wait` exits as soon as the starts have landed; the executions are then driven by the server's
  recovery pass (they are resumed from the event log).
- It boots like the server but binds no port and runs no periodic sweeps. Recovery runs, so any other
  abandoned execution is also resumed.
- It is safe to repeat: a document with a status row for its current generation is not selected, and
  starts are once-only per execution. Documents are taken in batches of 100.
- It logs counts only (documents started), never ids or names. Exit code 1 means a failure (the class
  is logged); 0 means every selected document was started.
