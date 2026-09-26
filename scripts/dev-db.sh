#!/usr/bin/env bash
# Project-local Postgres: its own data directory and port, so nothing global is
# touched. Prints the DATABASE_URL to use.
#
#   scripts/dev-db.sh start | stop | url
#   scripts/dev-db.sh fresh <name>     an empty database <name> (dropped first), its URL
set -euo pipefail
cd "$(dirname "$0")/.."
DATA=.rec/pgdata
PORT=${PGPORT_DEV:-5439}
# libpq on PATH ships initdb without a server; use the full install when present.
PGBIN=${PGBIN:-$(ls -d /opt/homebrew/opt/postgresql@*/bin 2>/dev/null | sort -V | tail -1)}
[ -n "$PGBIN" ] && export PATH="$PGBIN:$PATH"
URL="postgres://$(whoami)@127.0.0.1:$PORT/open_ledger"

case "${1:-start}" in
  start)
    if [ ! -d "$DATA" ]; then
      mkdir -p .rec
      initdb -D "$DATA" -A trust -U "$(whoami)" >/dev/null
    fi
    if ! pg_ctl -D "$DATA" status >/dev/null 2>&1; then
      pg_ctl -D "$DATA" -o "-p $PORT -k /tmp -c listen_addresses=127.0.0.1" -l .rec/pg.log -w start >/dev/null
    fi
    psql -h 127.0.0.1 -p "$PORT" -d postgres -tAc "select 1 from pg_database where datname='open_ledger'" | grep -q 1 \
      || createdb -h 127.0.0.1 -p "$PORT" open_ledger
    echo "$URL"
    ;;
  # A server resumes every unfinished intent in its database, and some scenarios leave
  # one that never finishes on purpose (l6: a commit no bridge confirms). Runs that
  # must not see an earlier run's intents get a database of their own.
  fresh)
    "$0" start >/dev/null
    name=${2:?database name}
    dropdb -h 127.0.0.1 -p "$PORT" --if-exists --force "$name" 2>/dev/null
    createdb -h 127.0.0.1 -p "$PORT" "$name"
    echo "postgres://$(whoami)@127.0.0.1:$PORT/$name"
    ;;
  stop) pg_ctl -D "$DATA" -m fast stop ;;
  url) echo "$URL" ;;
esac
