#!/bin/sh
# The local Postgres cluster DocMind's .env points at (127.0.0.1:55432), kept outside /tmp so it survives
# a reboot or a temp-folder clean. Usage: infra/local-db.sh start|stop|status
#   PG_BIN           Postgres binaries (default /Library/PostgreSQL/17/bin, the EDB installer's path)
#   DOCMIND_PGDATA   the cluster's data directory (default ~/.docmind/pgdata)
# Create the cluster once with initdb (owner role and password as in DOCMIND_MIGRATE_URL), create the
# database and the vector extension, then run `pnpm db:migrate`.
set -eu

PG_BIN=${PG_BIN:-/Library/PostgreSQL/17/bin}
DATA=${DOCMIND_PGDATA:-$HOME/.docmind/pgdata}
OPTS="-p 55432 -c max_connections=300 -c listen_addresses=127.0.0.1"

if [ ! -f "$DATA/PG_VERSION" ]; then
  echo "no local Postgres cluster at $DATA (set DOCMIND_PGDATA, create it with initdb, or run Postgres another way, e.g. docker compose)" >&2
  # `start` runs inside `pnpm serve`, which must still work against a Postgres run some other way.
  [ "${1:-}" = start ] && exit 0
  exit 1
fi

case "${1:-}" in
  start)
    if "$PG_BIN/pg_ctl" -D "$DATA" status >/dev/null 2>&1; then
      echo "Postgres is already running ($DATA)"
    else
      "$PG_BIN/pg_ctl" -D "$DATA" -o "$OPTS" -l "$DATA/../postgres.log" -w start
    fi
    ;;
  stop) "$PG_BIN/pg_ctl" -D "$DATA" -m fast -w stop ;;
  status) "$PG_BIN/pg_ctl" -D "$DATA" status ;;
  *)
    echo "usage: $0 start|stop|status" >&2
    exit 2
    ;;
esac
