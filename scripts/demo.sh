#!/usr/bin/env bash
# Runs Tally on a throwaway Postgres filled with a made-up year of transactions, for screenshots
# and trying things out. Your real database is never touched. Builds the current checkout first,
# serves it on http://127.0.0.1:${DEMO_PORT:-18080} and stops (deleting the data) on Ctrl-C.
#
#   demo                  (the devenv script; or scripts/demo.sh inside the dev shell)
#   DEMO_PASSKEY=1 demo   with passkey sign-in on, at http://localhost:18080 (passkeys can't be
#                         made for an IP address); the passkey file is deleted on exit too
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

server=
passkey_dir=
trap 'kill "$server" 2>/dev/null || true; [[ -z "$passkey_dir" ]] || rm -rf "$passkey_dir"' EXIT

# Starts the server with any extra environment given as arguments, and waits until it answers.
start() {
  env RUST_LOG="${RUST_LOG:-warn}" LISTEN_ADDR="127.0.0.1:$port" WEB_DIR="$repo/web/dist" "$@" "$target/debug/tally" &
  server=$!
  until curl -fs -o /dev/null "$url/"; do
    kill -0 "$server" 2>/dev/null || { echo "the demo server stopped" >&2; exit 1; }
    sleep 0.3
  done
}

start
(cd "$repo/web" && node demo/fill.mjs "$url")

# The fill script has no passkey, so sign-in is only turned on once the data is in.
if [[ -n "${DEMO_PASSKEY:-}" ]]; then
  kill "$server"
  wait "$server" 2>/dev/null || true
  passkey_dir="$(mktemp -d)"
  start PASSKEY_FILE="$passkey_dir/passkey.json"
  url="http://localhost:$port"
fi

echo "Demo running at $url (Ctrl-C to stop)"
wait "$server"
