#!/bin/sh
# Smoke test of the DocMind container image against a Postgres you provide.
# Usage: infra/smoke-image.sh <image>
#   SMOKE_PG_URL   an owner/superuser URL of an empty database with pgvector >= 0.8 available
#                  (default postgres://postgres:postgres@127.0.0.1:5432/postgres, the CI service)
# Needs Linux Docker (containers use --network host to reach the database on 127.0.0.1) and openssl.
# Checks: the migration job runs, the server boots read-only as a non-root user with minimal
# environment, reports healthy, serves /healthz and the web app, really parses a document through
# the parser sandbox, and exits 0 on `docker stop` within the 65 s termination grace. A SIGTERM sent
# during boot must also end the container promptly (exit 0 or 143, never 137 and never the full grace).
set -eu

IMAGE=${1:?usage: infra/smoke-image.sh <image>}
PG_URL=${SMOKE_PG_URL:-postgres://postgres:postgres@127.0.0.1:5432/postgres}
NAME=docmind-smoke
VOLUME=docmind-smoke-blobs
APP_PW=smoke-app-pw
LOOM_PW=smoke-loom-pw
ENV_FILE=$(mktemp)

cleanup() {
  docker rm -f "$NAME" "$NAME-early" >/dev/null 2>&1 || true
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

echo "== SIGTERM during boot ends the container promptly"
# docker stop right after docker run, while the server is still booting (before it can handle the signal).
docker run -d --name "$NAME-early" --network host --read-only --tmpfs /tmp \
  -v "$VOLUME":/var/lib/docmind/blobs --env-file "$ENV_FILE" "$IMAGE" >/dev/null
sleep 1
start=$(date +%s)
docker stop -t 65 "$NAME-early" >/dev/null
elapsed=$(($(date +%s) - start))
code=$(docker inspect -f '{{.State.ExitCode}}' "$NAME-early")
echo "early stop: exit code $code after ${elapsed}s"
case "$code" in 0 | 143) ;; *) fail "early stop exit code $code (0 or 143 expected; 137 is SIGKILL)" ;; esac
[ "$elapsed" -lt 30 ] || fail "early stop took ${elapsed}s, close to the whole grace"
docker rm "$NAME-early" >/dev/null

echo "== start the server"
docker run -d --name "$NAME" --network host --read-only --tmpfs /tmp \
  --health-interval 3s --health-timeout 5s --health-start-period 0s --health-retries 3 \
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
[ "$(docker exec "$NAME" cat /proc/1/comm)" = tini ] || fail "PID 1 is not tini"
child=$(docker exec "$NAME" sh -c 'cat /proc/1/task/1/children' | awk '{print $1}')
[ -n "$child" ] && [ "$(docker exec "$NAME" cat "/proc/$child/comm")" = node ] || fail "node is not tini's child"

echo "== healthcheck reports healthy"
healthy=
for _ in $(seq 1 30); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' "$NAME")" = healthy ] && { healthy=1; break; }
  sleep 2
done
[ -n "$healthy" ] || fail "the container did not become healthy (status $(docker inspect -f '{{.State.Health.Status}}' "$NAME"))"

echo "== parser sandbox parses a document (real spawn path: sh, ulimit, env -i, node --permission)"
PARSE_JS='
const { ParseRunner } = require("@docmind/parsers");
const runner = new ParseRunner({ limits: { wallClockMs: 20000, memoryMb: 256, maxInputBytes: 1000000, maxChars: 1000000 } });
runner.run("md", new TextEncoder().encode("# Title\n\nsmoke body text\n"))
  .then((doc) => { if (!doc.text.includes("smoke body text")) throw new Error("text missing"); console.log("parsed", doc.sections.length, "section(s)"); return runner.close(); })
  .then(() => process.exit(0), (err) => { console.error("parse failed:", err && err.constructor && err.constructor.name); process.exit(1); });
'
docker exec -w /src/docmind/apps/server "$NAME" node -e "$PARSE_JS" || fail "the parser sandbox could not parse a markdown document"

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
