#!/usr/bin/env bash
# Runs a command against a throwaway Postgres server that is deleted afterwards.
# The command sees DATABASE_URL (and TEST_DATABASE_URL for the integration tests).
#
#   scripts/with-ephemeral-postgres.sh cargo test --workspace
set -euo pipefail

pg_dir="$(mktemp -d)"
cleanup() {
  pg_ctl -D "$pg_dir/data" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$pg_dir"
}
trap cleanup EXIT

initdb -D "$pg_dir/data" --username=postgres --auth=trust --no-locale --encoding=UTF8 --no-sync >/dev/null
# Unix socket only (no TCP port), fsync off: nothing here needs to survive a crash.
pg_ctl -D "$pg_dir/data" -o "-F -h '' -k $pg_dir -c max_connections=200" -w start >/dev/null

export DATABASE_URL="postgres://postgres@localhost/postgres?host=$pg_dir"
export TEST_DATABASE_URL="$DATABASE_URL"
"$@"
