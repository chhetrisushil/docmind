#!/bin/sh
# The local Postgres clusters, kept outside /tmp so they survive a reboot or a temp-folder clean.
# Usage: infra/local-db.sh start|stop|status|init-test
#   dev   127.0.0.1:55432, DOCMIND_PGDATA (default ~/.docmind/pgdata): what DocMind's .env points at
#   test  the port in DOCMIND_TEST_PG_URL (read from .env; anything but 55432), DOCMIND_TEST_PGDATA (default
#         ~/.docmind/pgdata-test). The Postgres suites reset cluster-wide role passwords, so they must never share
#         the dev cluster.
#   PG_BIN  Postgres binaries (default /Library/PostgreSQL/17/bin, the EDB installer's path)
# Create the dev cluster once with initdb (owner role and password as in DOCMIND_MIGRATE_URL), create the
# database and the vector extension, then run `pnpm db:migrate`. Create the test cluster with `init-test`.
# start, stop and status act on the dev cluster and, when it exists, the test cluster.
set -eu

PG_BIN=${PG_BIN:-/Library/PostgreSQL/17/bin}
DATA=${DOCMIND_PGDATA:-$HOME/.docmind/pgdata}
TEST_DATA=${DOCMIND_TEST_PGDATA:-$HOME/.docmind/pgdata-test}
OPTS="-c max_connections=300 -c listen_addresses=127.0.0.1"

# $1 data directory, $2 port, $3 action, $4 log file
run() {
  case "$3" in
    start)
      if "$PG_BIN/pg_ctl" -D "$1" status >/dev/null 2>&1; then
        echo "Postgres is already running ($1)"
      else
        "$PG_BIN/pg_ctl" -D "$1" -o "-p $2 $OPTS" -l "$4" -w start
      fi
      ;;
    stop) "$PG_BIN/pg_ctl" -D "$1" -m fast -w stop ;;
    status) "$PG_BIN/pg_ctl" -D "$1" status || true ;;
  esac
}

# DOCMIND_TEST_PG_URL's port, user and password (one per line), from .env; empty when it is not set.
test_url() {
  node --env-file-if-exists=.env -e '
    const raw = process.env.DOCMIND_TEST_PG_URL;
    if (!raw) process.exit(0);
    const u = new URL(raw);
    if ((u.port || "5432") === "55432") {
      console.error("DOCMIND_TEST_PG_URL must not use 55432, the dev cluster: the suites reset its role passwords");
      process.exit(1);
    }
    console.log(u.port || "5432"); console.log(decodeURIComponent(u.username)); console.log(decodeURIComponent(u.password));'
}

# The test cluster: initdb as the user and password in DOCMIND_TEST_PG_URL, then start it on that URL's port.
init_test() {
  creds=$(test_url)
  [ -n "$creds" ] || { echo "DOCMIND_TEST_PG_URL is not set (in .env)" >&2; exit 1; }
  port=$(printf '%s\n' "$creds" | sed -n 1p)
  if [ ! -f "$TEST_DATA/PG_VERSION" ]; then
    pwfile=$(mktemp)
    trap 'rm -f "$pwfile"' EXIT
    printf '%s\n' "$creds" | sed -n 3p > "$pwfile"
    mkdir -p "$(dirname "$TEST_DATA")"
    "$PG_BIN/initdb" -D "$TEST_DATA" -U "$(printf '%s\n' "$creds" | sed -n 2p)" --pwfile="$pwfile" -A scram-sha-256 >/dev/null
  fi
  run "$TEST_DATA" "$port" start "$TEST_DATA/../postgres-test.log"
  echo "test cluster ready at 127.0.0.1:$port ($TEST_DATA)"
}

case "${1:-}" in
  init-test)
    init_test
    exit 0
    ;;
  start | stop | status) ;;
  *)
    echo "usage: $0 start|stop|status|init-test" >&2
    exit 2
    ;;
esac

if [ ! -f "$DATA/PG_VERSION" ]; then
  echo "no local Postgres cluster at $DATA (set DOCMIND_PGDATA, create it with initdb, or run Postgres another way, e.g. docker compose)" >&2
  # `start` runs inside `pnpm serve`, which must still work against a Postgres run some other way.
  [ "$1" = start ] && exit 0
  exit 1
fi
run "$DATA" 55432 "$1" "$DATA/../postgres.log"
if [ -f "$TEST_DATA/PG_VERSION" ]; then
  port=$(test_url | sed -n 1p)
  if [ -n "$port" ]; then run "$TEST_DATA" "$port" "$1" "$TEST_DATA/../postgres-test.log"; fi
fi
