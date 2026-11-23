#!/usr/bin/env bash
# Runs Tally on a throwaway Postgres filled with a made-up year of transactions, for screenshots
# and trying things out. Your real database is never touched. Builds the current checkout first,
# serves it on http://127.0.0.1:${DEMO_PORT:-18080} and stops (deleting the data) on Ctrl-C.
#
#   demo            (the devenv script; or scripts/demo.sh inside the dev shell)
set -euo pipefail

if [[ -z "${TALLY_DEMO_DB:-}" ]]; then
  exec env TALLY_DEMO_DB=1 "$(dirname "$0")/with-ephemeral-postgres.sh" "$0" "$@"
fi

repo="$(cd "$(dirname "$0")/.." && pwd)"
port="${DEMO_PORT:-18080}"
url="http://127.0.0.1:$port"

(cd "$repo/web" && npm run -s build >/dev/null)
cargo build -q -p tally-server --manifest-path "$repo/Cargo.toml"
target="$(cargo metadata --format-version 1 --no-deps --manifest-path "$repo/Cargo.toml" | node -p 'JSON.parse(require("fs").readFileSync(0)).target_directory')"

RUST_LOG="${RUST_LOG:-warn}" LISTEN_ADDR="127.0.0.1:$port" WEB_DIR="$repo/web/dist" "$target/debug/tally" &
server=$!
trap 'kill "$server" 2>/dev/null || true' EXIT
until curl -fsS -o /dev/null "$url/"; do
  kill -0 "$server" 2>/dev/null || { echo "the demo server stopped" >&2; exit 1; }
  sleep 0.3
done

(cd "$repo/web" && node demo/fill.mjs "$url")
echo "Demo running at $url (Ctrl-C to stop)"
wait "$server"
