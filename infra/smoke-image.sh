#!/bin/sh
# Smoke test of the DocMind container image against a Postgres you provide.
# Usage: infra/smoke-image.sh <image>
#   SMOKE_PG_URL   an owner/superuser URL of an empty database with pgvector >= 0.8 available
#                  (default postgres://postgres:postgres@127.0.0.1:5432/postgres, the CI service)
# Needs Linux Docker (containers use --network host to reach the database on 127.0.0.1) and openssl.
# Checks: the migration job runs, the server boots read-only as a non-root user with minimal
# environment, serves /healthz and the web app, has what the parser sandbox spawns, and exits 0 on
# `docker stop` within the 65 s termination grace.
set -eu

IMAGE=${1:?usage: infra/smoke-image.sh <image>}
PG_URL=${SMOKE_PG_URL:-postgres://postgres:postgres@127.0.0.1:5432/postgres}
NAME=docmind-smoke
VOLUME=docmind-smoke-blobs
APP_PW=smoke-app-pw
LOOM_PW=smoke-loom-pw
ENV_FILE=$(mktemp)

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker volume rm "$VOLUME" >/dev/null 2>&1 || true
  rm -f "$ENV_FILE"
}
trap cleanup EXIT
fail() {
  echo "SMOKE FAILED: $1" >&2
  docker logs "$NAME" 2>&1 | tail -n 60 >&2 || true
  exit 1
}

# The same URL with another user and password: scheme://user:pw@rest -> scheme://<user>:<pw>@rest.
as_role() { printf '%s' "$PG_URL" | sed -E "s#^([a-z]+://)[^@]*@#\1$1:$2@#"; }

echo "== migration job"
docker run --rm --network host \
  -e DOCMIND_MIGRATE_URL="$PG_URL" \
  -e DOCMIND_APP_DB_PASSWORD="$APP_PW" \
  -e DOCMIND_LOOM_DB_PASSWORD="$LOOM_PW" \
  "$IMAGE" node --import tsx apps/server/app/db/migrate.ts

echo "== start the server (read-only root, tmpfs /tmp, blob volume)"
cat >"$ENV_FILE" <<ENV
DATABASE_URL=$(as_role docmind_app "$APP_PW")
LOOM_DATABASE_URL=$(as_role docmind_loom "$LOOM_PW")
DOCMIND_KEK=$(openssl rand -base64 32)
DOCMIND_CHAT_ENVELOPE_KEY=$(openssl rand -base64 32)
DOCMIND_OLLAMA_URL=http://127.0.0.1:1
ENV
docker volume create "$VOLUME" >/dev/null
docker run -d --name "$NAME" --network host --read-only --tmpfs /tmp \
  -v "$VOLUME":/var/lib/docmind/blobs --env-file "$ENV_FILE" "$IMAGE" >/dev/null

echo "== wait for /healthz"
ok=
for _ in $(seq 1 90); do
  [ "$(docker inspect -f '{{.State.Running}}' "$NAME")" = true ] || fail "the server container exited"
  if curl -fsS http://127.0.0.1:3000/healthz >/dev/null 2>&1; then ok=1; break; fi
  sleep 1
done
[ -n "$ok" ] || fail "/healthz did not return 200 within 90 s"
echo "healthz: $(curl -fsS http://127.0.0.1:3000/healthz)"

echo "== image properties"
[ "$(docker exec "$NAME" id -u)" != 0 ] || fail "the server runs as root"
curl -fsS http://127.0.0.1:3000/ | grep -qi "<html" || fail "the web app is not served at /"
docker exec "$NAME" sh -c 'test -x /bin/sh && test -x /usr/bin/env && test -f /src/docmind/packages/parsers/dist/child/child.cjs' \
  || fail "the parser sandbox's /bin/sh, /usr/bin/env or child bundle is missing"
[ "$(docker exec "$NAME" cat /proc/1/comm)" = node ] || fail "PID 1 is not node"

echo "== graceful stop (SIGTERM, grace 65 s)"
start=$(date +%s)
docker stop -t 65 "$NAME" >/dev/null
elapsed=$(($(date +%s) - start))
code=$(docker inspect -f '{{.State.ExitCode}}' "$NAME")
echo "exit code $code after ${elapsed}s"
[ "$code" = 0 ] || fail "exit code $code, not 0 (SIGKILL is 137)"
[ "$elapsed" -lt 65 ] || fail "stop took ${elapsed}s"
docker logs "$NAME" 2>&1 | tail -n 5
echo "SMOKE OK"
