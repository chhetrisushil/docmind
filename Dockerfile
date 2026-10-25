# syntax=docker/dockerfile:1.7
#
# DocMind's container image. One image runs both the server and the migration job (see
# docs/operations/cloud-deploy.md).
#
# DocMind links the sibling loom and loom-ui checkouts (`link:../loom/...` in pnpm-workspace.yaml), so
# they come in as BuildKit named build contexts and are laid out as /src/{docmind,loom,loom-ui}, the
# same relative layout the links expect. Build from a CLEAN checkout of each (as CI does): a
# local checkout's node_modules, .turbo or model caches would be sent as context.
#
#   docker buildx build \
#     --build-context loom=../loom --build-context loom-ui=../loom-ui \
#     -t docmind:local .
#
# Base: Debian bookworm-slim. The parser sandbox spawns `/bin/sh -c 'ulimit ...; exec /usr/bin/env -i
# node --permission ...'` (packages/parsers/src/runner/protocol.ts), so the image needs /bin/sh and
# /usr/bin/env: no distroless, no scratch. glibc (not Alpine) keeps the prebuilt argon2 and esbuild binaries usable.
ARG NODE_IMAGE=node:22-bookworm-slim

# ---------------------------------------------------------------- build
FROM ${NODE_IMAGE} AS build
# pnpm comes from each project's `packageManager` field (docmind, loom and loom-ui pin their own).
# The pnpm store lives outside every project, so no .pnpm-store lands in a project layer; the cache
# mounts below point at it.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    CI=true \
    npm_config_store_dir=/pnpm-store
RUN corepack enable
WORKDIR /src

# Same steps, same order as .github/workflows/ci.yml. `find` clears any node_modules a local
# context carried in (another platform's binaries); pnpm then installs from the lockfile.
COPY --from=loom . /src/loom
RUN find /src/loom -name node_modules -type d -prune -exec rm -rf {} + \
 && rm -rf /src/loom/.git
WORKDIR /src/loom
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store \
    pnpm install --frozen-lockfile && pnpm build

COPY --from=loom-ui . /src/loom-ui
RUN find /src/loom-ui -name node_modules -type d -prune -exec rm -rf {} + \
 && rm -rf /src/loom-ui/.git
WORKDIR /src/loom-ui
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store \
    pnpm install --frozen-lockfile \
 && pnpm --filter @loom-ui/core --filter @loom-ui/hydration --filter @loom-ui/renderer-lit --filter @loom-ui/renderer-terminal build

# The whole tree is copied before the install (no manifests-first layer): the link: targets above must
# already be in place, and pnpm needs every workspace package.json. The pnpm store cache mount keeps
# reinstalls cheap.
COPY . /src/docmind
WORKDIR /src/docmind
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store \
    pnpm install --frozen-lockfile && pnpm build

# Drop what the runtime never reads, so the next stage copies less. Nothing here is a link target of
# the server (it needs loom's packages/ and plugins/, loom-ui's packages/, and their node_modules).
RUN rm -rf /src/loom/.turbo /src/loom/.models /src/loom/.superpowers /src/loom/docs /src/loom/evals \
        /src/loom/examples /src/loom/apps /src/loom-ui/.turbo /src/loom-ui/docs

# ---------------------------------------------------------------- runtime
FROM ${NODE_IMAGE} AS runtime

# tini is PID 1. Node as PID 1 gets no kernel default action for a signal it has no handler for yet,
# so a SIGTERM that arrives during boot, before main.ts registers its handler, would be dropped and
# the container would run until SIGKILL. tini forwards SIGTERM to node, whose default action then
# ends the process. (It also reaps any orphan.)
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/*

# tsx: the server has a compiled build (apps/server/dist) but runs from source, like `pnpm start`:
# db/migrate.ts finds infra/migrations relative to its own file (four levels up), which is right
# for app/db but wrong for dist/app/db, and the boot checksum check reads the same directory.
# `node --import tsx` is one process: tini runs it as its only child and forwards SIGTERM.
#   - TSX_DISABLE_CACHE: tsx would otherwise cache transforms under the temp dir; with the cache off
#     the server boots with an unwritable TMPDIR (a read-only root filesystem).
#   - HOST: the default 127.0.0.1 is unreachable from outside the container.
#   - DOCMIND_BLOB_DIR: the one path the server writes; mount durable storage here.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DOCMIND_WEB_DIR=/src/docmind/apps/web/dist \
    DOCMIND_BLOB_DIR=/var/lib/docmind/blobs \
    TSX_DISABLE_CACHE=1

# The same layout as the build, so pnpm's relative symlinks keep resolving. Read-only to the app user.
COPY --from=build /src/loom /src/loom
COPY --from=build /src/loom-ui /src/loom-ui
COPY --from=build /src/docmind /src/docmind

# uid/gid 1000 ("node", already in the base image). Mount points for EFS/Filestore access points
# must therefore be owned by, or mapped to, uid 1000.
RUN mkdir -p /var/lib/docmind/blobs && chown node:node /var/lib/docmind/blobs
VOLUME /var/lib/docmind/blobs

USER node
WORKDIR /src/docmind
EXPOSE 3000
STOPSIGNAL SIGTERM

# /healthz is liveness only: a static 200 (it does not check the database). No curl in slim: use node.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

# Exec form, no shell: tini (PID 1) starts node and forwards signals to it; the server handles
# SIGTERM itself once booted (apps/server/app/main.ts) and exits with its own code, which tini passes on.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--import", "tsx", "apps/server/app/main.ts"]

# The migration job is this same image with another command (no .env file here, so
# no --env-file): DOCMIND_MIGRATE_URL, DOCMIND_APP_DB_PASSWORD and DOCMIND_LOOM_DB_PASSWORD from the environment:
#   node --import tsx apps/server/app/db/migrate.ts
