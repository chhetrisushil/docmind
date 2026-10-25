# @docmind/loadtest

A repeatable load test for **one DocMind server process**. It measures DocMind itself, not a model provider: every
model call goes to a stub with fixed latency.

## What it answers

- Read path: how many requests per second, and at what latency, the authenticated page-load routes serve.
- Chat: how many chat turns can run at once, and how long the first answer token and the whole turn take.
- Ingest: how many documents per minute reach `ready`.

## Prerequisites

- Postgres: `pnpm db:start`, then `pnpm db:migrate` (needs `.env`, see `.env.example`).
- The sibling `../loom` and `../loom-ui` checkouts, built as for `pnpm start`.
- The workspace installed: `pnpm install`.

The scenarios sign up users in the database named by `DATABASE_URL`. Use a throwaway database, or remove the
`loadtest-N@example.test` accounts afterwards (`DELETE /api/me` with the password in the seed state).

## Run it

Four terminals, from the repo root.

1. The stub (defaults: 300 ms to first token, 120 tokens, 15 ms between tokens, 20 ms per embedding call):

   ```sh
   pnpm --filter @docmind/loadtest stub -- --first-token-ms 300 --tokens 120 --token-delay-ms 15 --embed-ms 20
   ```

   Flags have env twins: `STUB_FIRST_TOKEN_MS`, `STUB_TOKENS`, `STUB_TOKEN_DELAY_MS`, `STUB_EMBED_MS`,
   `STUB_DIMENSIONS`, `STUB_PORT`. Add `--tool-call` (`STUB_TOOL_CALL=1`) and each chat turn first asks for
   `search_docs`, so it also runs retrieval: an embedding call, pgvector search, then a second model call.

2. The server, with every model role on the stub. Process variables win over `.env`:

   ```sh
   DOCMIND_OLLAMA_URL=http://127.0.0.1:11500 \
   DOCMIND_LLM_PROVIDER=ollama \
   DOCMIND_CHAT_MODEL=stub DOCMIND_TITLE_MODEL=stub DOCMIND_SUMMARY_MODEL=stub DOCMIND_VISION_MODEL=stub \
   DOCMIND_VISION_PDF_PROVIDER=off \
   DOCMIND_EMBED_MODEL=stub-embed DOCMIND_EMBED_DIMENSIONS=768 \
   DOCMIND_TRUST_PROXY=true \
   PORT=3100 DOCMIND_WEB_DIR= DOCMIND_BLOB_DIR=./data/loadtest/blobs \
   pnpm exec tsx --env-file=.env apps/server/app/main.ts
   ```

   `DOCMIND_TRUST_PROXY=true` lets the seeder give each user its own client address, because sign-up is
   throttled to 5 per address. (Never set it without a proxy in production.)

3. Seed once. This signs up the users, uploads three documents each (two generated markdown files and the PDF
   from `packages/parsers/test-fixtures`), waits for `ready` and creates the chats. Cookies, document ids and chat
   ids go to `data/loadtest/state.json` (git-ignored, mode 600).

   ```sh
   export LOADTEST_URL=http://127.0.0.1:3100
   pnpm --filter @docmind/loadtest seed -- --users 20 --chats 5
   ```

   Sign-up allows 3 attempts per email in two hours; for a re-seed from scratch use `--prefix other`.

4. Scenarios. Pass `--server-pid <pid>` to also record the server's CPU (cores busy) and peak RSS.

   ```sh
   pnpm --filter @docmind/loadtest read   -- --steps 10,50,100,200,400 --duration 10 --server-pid <pid>
   pnpm --filter @docmind/loadtest chat   -- --ramp 5,10,25,50,100 --duration 30 --server-pid <pid>
   pnpm --filter @docmind/loadtest ingest -- --docs 20 --concurrency 8
   ```

## Scenarios

### read

autocannon against the routes a page load uses, rotating through the users' cookies on every connection:
`GET /api/me`, `GET /api/documents`, `GET /api/documents/:id`, `GET /api/chats`, `GET /api/ui/views/library`, and
`POST /api/ui/hydrate` for the library, detail and sessions views (the same handle sets the web app asks for; the
scenario checks once that they answer `ready`). `mixed` interleaves all of them. `--steps` runs each route at each
connection count and prints one table, so the knee (where req/s stops growing and latency climbs) is visible.
`--routes hydrate-library,mixed` limits the routes.

Columns: req/s, latency p50, p90, p97.5 and p99 (autocannon's histogram has no p95), max, non-2xx responses,
errors plus timeouts, `probe p99`, `cpu`, `rss`. `probe p99` is the latency of `GET /healthz` polled every 100 ms
from a separate thread. `/healthz` does no work, so its latency is time spent queued behind the server's event
loop. A rising probe means the event loop is saturated. `cpu` is cores busy, from `ps` cpu time.

### chat

Each virtual user keeps its chat's SSE stream open, `POST`s a message (expects 202) and times:

- time to first token: message sent to the first `answer` frame;
- full turn: message sent to the assistant `message` frame.

It also counts `reset` frames, stream errors, non-202 sends, failed turns and timeouts. The ramp runs each level for
`--duration` seconds with every virtual user sending turns back to back. This is limited by concurrent turns, not by
QPS: a turn lasts about `first-token + tokens x delay` however idle the server is, so turns/s is roughly
concurrency divided by that. What matters is when TTFT and the probe latency leave the stub's floor. The server
allows 4 open chat streams per user and 1000 in all, so concurrency is capped at users x min(4, chats).

### ingest

Uploads `--docs` unique markdown documents with `--concurrency` in flight, spread over the seeded users, then polls
until each is `ready`. Reports docs/min, upload latency, upload-to-ready latency. One user may have
`DOCMIND_MAX_CONCURRENT_UPLOADS` (default 2) uploads in flight; above that the server answers `429
too_many_uploads`. The scenario counts these, waits a second and retries; they are the limit working, not a
failure.

## Caveats

- One server process is what DocMind supports, so these are single-process numbers. The server is one Node event
  loop plus a Postgres pool (node-postgres default of 10 connections, no `max` set).
- Run on a laptop, the load generator, the stub, Postgres and the server share the same CPUs. Numbers are lower
  bounds for the server and do not carry over to a cloud machine. Treat them as shapes (where the knee is, what
  saturates), and compare runs on the same machine.
- Cookies are reused: login is throttled, so the seeder logs in once per user. Sessions expire (see
  `SESSION_TTL_MS`); re-seed for a stale state.
- The stub's chat answer is generic text, so citations, grounding and long-context cost are not exercised.
  Real models add their own latency and rate limits on top.
- The data is small (3 documents per user). Vector search and list queries on large libraries cost more.
