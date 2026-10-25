# Deploying DocMind to the cloud (one replica)

This is stage 0 of [cloud-scaling.md](../design/cloud-scaling.md) §5: **one container**, a managed
Postgres, a shared POSIX volume for the encrypted blobs, and hosted or private models. It covers the
container image, the migration job, the environment, and what each platform needs.

Statements marked **(not verified)** come from the design note or from reading a vendor's documentation,
not from a run against that platform. The image itself is built and smoke-tested in CI (job `image` in
`.github/workflows/ci.yml`, script `infra/smoke-image.sh`).

## 1. Hard rules

- **Run exactly one replica**, and deploy by **recreate** (stop the old container, then start the new
  one), never rolling. The progress bus, the chat live layer, the stop registry and the subject index are
  in memory; blobs are on a local filesystem; an old-version node can give up a new-version execution
  during a rolling deploy. See [cloud-scaling.md §4](../design/cloud-scaling.md#4-required-for-n-replicas)
  (S1 to S8). Set the platform's desired count and maximum to 1.
- **Termination grace longer than `DOCMIND_SHUTDOWN_DEADLINE_MS` plus 5 s (not possible on Cloud Run, section 8).**
  The recommended cloud values are a deadline of 85 s and a shutdown delay of 15 s (section 8), which give a
  **grace of at least 90 s**. The close steps are bounded at about 62 s (`apps/server/app/shutdown.ts`), and
  the boot refuses a delay that does not fit in the deadline next to them. A SIGKILL at a platform default of
  10 to 30 s skips the lease release, so recovery then waits out the 30 s lease TTL (cloud-scaling.md C6).
- **Memory of at least 3 to 4 GiB, enforced by a cgroup limit** (cloud-scaling.md C12). Each parse child
  has a 512 MiB V8 heap, but Buffer memory is not bounded by it (`packages/parsers/src/runner/ParseRunner.ts`),
  and up to four ingest steps each buffer a whole file. The recommended instance is 2 to 4 vCPU and 8 GiB.
- **Never scale to zero.** Recovery, sweeps and parked chat turns run outside requests.

## 2. Build the image

DocMind links the sibling `loom` and `loom-ui` checkouts, so they are passed as named build contexts. Use
the commits pinned as `LOOM_REF` and `LOOM_UI_REF` in `.github/workflows/ci.yml`, in **clean** checkouts
(a working checkout's `node_modules` and caches would be uploaded as context):

```sh
git clone <loom> ../loom && git -C ../loom checkout <LOOM_REF>
git clone <loom-ui> ../loom-ui && git -C ../loom-ui checkout <LOOM_UI_REF>
docker buildx build \
  --build-context loom=../loom --build-context loom-ui=../loom-ui \
  -t <registry>/docmind:<tag> .
docker push <registry>/docmind:<tag>
```

What is in the image:

- Base `node:22-bookworm-slim` (override with `--build-arg NODE_IMAGE=...`). It is Debian, not
  distroless, because the parser sandbox starts `/bin/sh -c 'ulimit ...; exec /usr/bin/env -i node --permission ...'`
  and needs both `/bin/sh` and `/usr/bin/env`. glibc keeps the prebuilt argon2 and esbuild binaries usable.
- The built workspace at `/src/docmind`, with `/src/loom` and `/src/loom-ui` beside it (pnpm's `link:`
  symlinks are relative, so the layout must not change), the web app at `apps/web/dist` and
  `infra/migrations`. The parser child bundle is `packages/parsers/dist/child/child.cjs`.
- It runs from source with `tsx` (`node --import tsx apps/server/app/main.ts`), like `pnpm start`. A
  compiled build exists (`apps/server/dist`) but is not used: `db/migrate.ts` finds `infra/migrations`
  four directories above its own file, which is right in `app/db` and wrong in `dist/app/db`, and the
  boot checksum check reads the same directory. Starting costs a few seconds of transform time.
- User `node` (uid/gid 1000). `tini` is PID 1 (`ENTRYPOINT ["/usr/bin/tini", "--"]`) and runs node as its
  only child, with no shell wrapper. The reason is boot: a process that is PID 1 gets no kernel default
  action for a signal it has no handler for, and the server registers its SIGTERM handler only after
  boot (`apps/server/app/main.ts`), so without tini a SIGTERM during start-up would be dropped and the
  container would run until SIGKILL. With tini the signal reaches node, which exits (143 before the
  handler exists, 0 after a clean shutdown). Do not also enable the platform's init flag.
- `HOST=0.0.0.0`, `PORT=3000` (the default, `apps/server/app/boot.ts`), `NODE_ENV=production`,
  `DOCMIND_WEB_DIR=/src/docmind/apps/web/dist`, `DOCMIND_BLOB_DIR=/var/lib/docmind/blobs` (a `VOLUME`),
  `STOPSIGNAL SIGTERM` and a `HEALTHCHECK` on `/healthz`. `.env` never enters the image (`.dockerignore`).

Image size: the runtime stage keeps the full installed workspaces (dev dependencies included) of docmind, loom
and loom-ui, so the image is large. It is deliberately not pruned, because the pruned layout cannot be
tested here. Pull time matters mostly on a cold start.

Read-only root filesystem: the server writes only under `DOCMIND_BLOB_DIR`. `TSX_DISABLE_CACHE=1` stops
`tsx` writing its transform cache to the temp directory (checked locally with an unwritable `TMPDIR`);
still mount a small `tmpfs` or `emptyDir` at `/tmp` as a precaution. The smoke test runs the container
with `--read-only --tmpfs /tmp`.

## 3. Run the migrations (a job, before each deploy)

The same image, another command. It needs no `.env` file:

```sh
docker run --rm \
  -e DOCMIND_MIGRATE_URL=postgres://<owner>:<password>@<host>/<db>?sslmode=verify-full \
  -e DOCMIND_APP_DB_PASSWORD=<password for docmind_app> \
  -e DOCMIND_LOOM_DB_PASSWORD=<password for docmind_loom> \
  <registry>/docmind:<tag> node --import tsx apps/server/app/db/migrate.ts
```

- `DOCMIND_MIGRATE_URL` is the database **owner** role. It must be able to create roles (`docmind_app`,
  `docmind_loom`) and the `vector` extension, so on managed Postgres use the admin role the service gives you.
- The two passwords set `LOGIN PASSWORD` on the two roles each time the job runs (it prints
  `applied: ...` or `schema is up to date`). They must equal the passwords in `DATABASE_URL` and
  `LOOM_DATABASE_URL` below. Skipping them leaves the roles `NOLOGIN`.
- Migrations are serialised by an advisory lock and refuse an applied file that changed. Run the job
  **before** starting the new server and make its failure stop the deploy: ECS, a one-off task or a
  `RunTask` step; Cloud Run, a Cloud Run job; Kubernetes, a `Job` or a Helm hook.
- The migration connection must be direct or session-mode, not a transaction pooler (cloud-scaling.md S8).

## 4. Environment of the server

Set these on the service. Variables not listed keep their defaults (see `.env.example` and
[architecture.md §11](../architecture.md#11-configuration-and-deployment)).

| Group | Variable | Cloud value |
| --- | --- | --- |
| Server | `DOCMIND_DEPLOYMENT` | `production`. The boot then refuses a missing `DOCMIND_CHAT_ENVELOPE_KEY`, a missing or non-`https:` `DOCMIND_PUBLIC_ORIGIN` and `DOCMIND_COOKIE_SECURE` other than `true`, and it warns when `DOCMIND_TRUST_PROXY` is off. |
| | `HOST` | `0.0.0.0` (set in the image; the code default `127.0.0.1` is unreachable from a load balancer) |
| | `PORT` | `3000` (image default) |
| | `DOCMIND_PUBLIC_ORIGIN` | The browser-visible origin, such as `https://docmind.example.com` (no path; default port omitted). Set it: the write-origin check then no longer depends on the proxy forwarding `Host` unchanged. |
| | `DOCMIND_COOKIE_SECURE` | `true` (the site is served over HTTPS) |
| | `DOCMIND_TRUST_PROXY` and `DOCMIND_TRUST_PROXY_HOPS` | `true`, and the hop count is the number of proxies of yours in front (default 1: the load balancer; 2 for a CDN in front of the load balancer). The client IP is the entry that many places from the right of `X-Forwarded-For` (`packages/auth/src/clientIp.ts`). **The origin must accept traffic only from the outermost proxy** (security group, or a CDN-only origin): a direct request with a forged header would otherwise pick its own login-throttle key. |
| Database | `DATABASE_URL` | `docmind_app` URL, password auth (section 6) |
| | `LOOM_DATABASE_URL` | `docmind_loom` URL, direct or session mode (section 6) |
| Keys | `DOCMIND_KEK_FILE` and `DOCMIND_KEK_ID` | Path of a file holding the base64 of 32 random bytes, mounted from the secret manager (`DOCMIND_KEK` itself also works but puts the key in the environment; `packages/keystore-pg/src/kek.ts`). `DOCMIND_KEK_ID` defaults to `kek-1`. **Losing the KEK makes every encrypted byte unreadable**: back it up separately from the database. Rotation: [rotate-kek.md](rotate-kek.md). |
| | `DOCMIND_CHAT_ENVELOPE_KEY_FILE` | **Required** (production refuses to boot without the key). 32 to 512 characters, for example `openssl rand -base64 32`. Unset in development, it is random per process: queued chat envelopes fail verification after every restart (`apps/server/app/chats/settings.ts`). |
| | Other secrets as files | `DATABASE_URL_FILE`, `LOOM_DATABASE_URL_FILE`, `ANTHROPIC_API_KEY_FILE`, `GEMINI_API_KEY_FILE`, `DOCMIND_CHAT_ENVELOPE_KEY_PREVIOUS_FILE`; for the migration job, `DOCMIND_MIGRATE_URL_FILE`, `DOCMIND_APP_DB_PASSWORD_FILE` and `DOCMIND_LOOM_DB_PASSWORD_FILE`. A non-empty `_FILE` wins over the plain variable; the file must be a regular file of at most 64 KiB, and its content is trimmed (`apps/server/app/secrets.ts`). |
| Storage | `DOCMIND_BLOB_DIR` | `/var/lib/docmind/blobs`, a shared volume (section 5) |
| | `DOCMIND_MAX_UPLOAD_BYTES` and the tenant limits | Defaults are 50 MiB per file; the maximum is 256 MiB. On Cloud Run keep it under 32 MiB (section 8). |
| Models | `DOCMIND_OLLAMA_URL`, `DOCMIND_EMBED_*`, per-role `DOCMIND_*_PROVIDER` / `_MODEL`, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY` | Section 7 |

Secrets (`DATABASE_URL`, `LOOM_DATABASE_URL`, `DOCMIND_CHAT_ENVELOPE_KEY`, the provider keys) must come
from the platform's secret store, never from the image or the task definition in plain text. The server
reads the other `DOCMIND_*` variables once at boot and fails with the variable's name, never its value.

## 5. Blob storage on a shared volume

Uploaded originals are encrypted files under `DOCMIND_BLOB_DIR`. The container's own disk is ephemeral, so
without a volume a restart loses every original file and any in-flight ingest (cloud-scaling.md C1). Mount
a network filesystem there:

- **AWS**: EFS. **Google Cloud**: Filestore. **Azure**: Azure Files over NFS 4.1 **(not verified)**.
- The store publishes each blob with `link()` and relies on an atomic `EEXIST`
  (`packages/blob-store/src/EncryptedFsContentStore.ts`). The filesystem must therefore support **hard
  links** and **atomic create-exclusive**, which NFSv4 volumes do and object-store FUSE mounts (s3fs,
  gcsfuse) do not. Do not use those.
- The server runs as uid/gid **1000**. Make the mount writable by it: an EFS access point with
  `PosixUser` 1000:1000 and `RootDirectory` permissions `0755` or stricter, or a `fsGroup`/`runAsUser`
  of 1000 on Kubernetes. The server creates per-user subdirectories with mode `0700`.
- Enable the volume's encryption in transit and at rest, and its backups. The blobs are already encrypted
  per user, but a lost volume is lost documents.
- At boot the server deletes upload temp files older than one hour in this directory.

This is a stopgap until an object-store `ContentStore` exists (cloud-scaling.md S1).

## 6. Managed Postgres

- **PostgreSQL 16 or later with pgvector 0.8.0 or later.** The server refuses to start below 0.8.0
  (`packages/vector-pg/src/pg.ts`) and the migrations create the extension. Check the extension version
  your service, region and major version offers **(not verified per vendor)**.
- **Password authentication for `docmind_app` and `docmind_loom`.** At boot each connection is refused
  when its role is a member of any other role, a superuser or a BYPASSRLS role, or can create roles
  (`apps/server/app/db/pool.ts`). IAM database authentication (RDS, Cloud SQL) works by granting a role
  membership (for example `rds_iam`), so it is refused. Use the passwords set by the migration job.
- **TLS** through `sslmode` in the URLs. DocMind passes the URL to `pg` and has no TLS option of its own. With the
  installed `pg-connection-string` 2.14, `sslmode=require` and `verify-ca` behave as `verify-full`
  (with a deprecation warning), so write `sslmode=verify-full`; if the service's CA is not a public one,
  add `sslrootcert=<path>` to a mounted CA file **(not verified against a managed service)**.
- **Direct or session-mode connections for `LOOM_DATABASE_URL` and the migration job**: Loom uses
  `LISTEN` and advisory locks, which break under PgBouncer transaction mode and RDS Proxy (cloud-scaling.md
  S8). `DATABASE_URL` is compatible with transaction pooling, but with one replica a pooler is unnecessary.
- **Connections**: about 24 per replica (app 10, Loom 10, erasure 3, one `LISTEN`; the design note's figure). Size
  `max_connections` above that plus the migration job.
- Keep backups for at most 30 days ([architecture.md §11](../architecture.md#11-configuration-and-deployment)).

## 7. Models

The image contains no model. Choose per role; the full list of roles, providers and what leaves the
network is in [llm-providers.md](llm-providers.md).

**Decided route (2026-10-25): a private Ollama service for embeddings.** Document text stays inside the
cloud account, and no code change or re-embed is needed. Chat and the other roles may still use hosted
providers per role.

- **Hosted providers** (nothing to run): set `DOCMIND_LLM_PROVIDER` or the per-role variables to `gemini`
  or `anthropic` with the key. **Embeddings are Ollama-only today** (`DOCMIND_OLLAMA_URL`; `vector(768)`
  in migration `0014`), so a fully managed setup is not possible until a hosted `EmbeddingProvider` exists
  (cloud-scaling.md C10). Changing the dimension needs a new migration and a re-embed.
- **A private Ollama** service (the decided route for embeddings) on the private network (a second ECS service, a GPU instance or pool),
  `DOCMIND_OLLAMA_URL=http://ollama.internal:11434`. Ollama has **no authentication**: reach it only over
  the private network and never expose it. DocMind rejects credentials embedded in the URL. Pull the
  embedding model (`nomic-embed-text` by default) and any local chat model before starting DocMind.
- Models whose name ends in `-cloud` send document text to Ollama's cloud (llm-providers.md).
- The server **boots without a reachable model**: the smoke test points `DOCMIND_OLLAMA_URL` at a closed
  port. Ingest and chat then fail at their model step, so verify the endpoint separately.

## 8. Load balancer, health checks and platforms

- **Health checks.** `GET /healthz` is **liveness**: it is static and always answers 200 while the process
  runs. `GET /readyz` is **readiness**: 200 when a database ping on its own connection succeeds within 1 s,
  503 `db_unavailable` otherwise, and 503 `shutting_down` from the moment SIGTERM arrives. Point the load
  balancer's target health check at `/readyz` with a failure threshold of **3 or more**, and liveness at
  `/healthz`. Both answer `HEAD` too.
- **Shutdown delay.** Set `DOCMIND_SHUTDOWN_DELAY_MS=15000` and `DOCMIND_SHUTDOWN_DEADLINE_MS=85000`. After
  SIGTERM the server keeps serving for the delay while `/readyz` answers 503, so the load balancer stops
  routing before the listener closes. The delay must be smaller than the deadline minus about 62 s of close
  steps, or the boot refuses it.
- **Keep-alive.** The server closes idle keep-alive sockets after **5 s** (`keepAliveTimeoutMs` in
  `apps/server/app/server.ts`). A load balancer with a longer idle timeout (ALB defaults to 60 s) reuses
  sockets Node already closed and returns intermittent 502s. Set `DOCMIND_KEEP_ALIVE_TIMEOUT_MS` above the
  load balancer's idle timeout (for example `65000` against ALB's 60 s) and `DOCMIND_HEADERS_TIMEOUT_MS`
  above that (`66000`); the boot refuses a headers timeout that is not greater.
- **Server-sent events**: the stream sends a heartbeat every 15 s and `x-accel-buffering: no`; the load
  balancer's idle timeout must exceed 15 s and responses must not be buffered. The per-request timeout is 60 s.
- **Affinity** is not needed with one replica.

### ECS on Fargate (recommended) **(not verified on a live account)**

- Task: 2 vCPU and 8 GiB (4 vCPU / 8 GiB for more ingestion), `readonlyRootFilesystem: true`, `user: 1000`,
  a `tmpfs`-style scratch volume at `/tmp`, an EFS volume (access point 1000:1000) at
  `/var/lib/docmind/blobs`, `stopTimeout: 120` (the Fargate maximum), secrets from Secrets Manager.
- Service: desired and maximum count 1, deployment type `recreate` (minimum healthy 0 %, maximum 100 %),
  an ALB target group with health check `/readyz` (unhealthy threshold 3) and a deregistration delay of about 15 s. Run the
  migration as a one-off task (`RunTask`) before updating the service.
- Fargate platform 1.4 or later is required for EFS.

### Kubernetes

A `Deployment` with `replicas: 1` and `strategy: Recreate`, `terminationGracePeriodSeconds: 95`,
`securityContext.runAsUser: 1000`, `readOnlyRootFilesystem: true`, an `emptyDir` at `/tmp`, a
`ReadWriteMany` volume claim for the blobs, a memory request equal to the limit, and the migration as a
`Job`. The `HEALTHCHECK` in the image is ignored by Kubernetes; define a `livenessProbe` on `/healthz`
with a generous `initialDelaySeconds` (recovery and subject-index hydration run at boot), and a
`readinessProbe` on `/readyz` with `failureThreshold: 3`.

### Cloud Run **(not verified here)**

Not recommended. The termination grace on Cloud Run is a fixed 10 seconds after SIGTERM and cannot be
raised **(from Google's documentation; not verified here)**, so the grace rule in section 1 cannot be
met. The server's close sequence can take up to about 62 s, so every stop (each deploy, each scale-in or
maintenance event) is cut off by SIGKILL mid-close: leases are not released and recovery then waits out
the 30 s lease TTL before it resumes interrupted ingests and chats. Data is not lost, but work stalls after each
restart. Use ECS/Fargate unless that is acceptable. If you still use Cloud Run:

- Request bodies over HTTP/1 are capped at **32 MiB**, below the 50 MiB upload default: set
  `DOCMIND_MAX_UPLOAD_BYTES` under 32 MiB (33554432).
- Background flows need **CPU always allocated** (instance-based billing) and **minimum instances 1**,
  with maximum instances 1.
- Mount Filestore as an NFS volume for the blobs (the in-memory volume is not durable).
- Run migrations as a Cloud Run job.
