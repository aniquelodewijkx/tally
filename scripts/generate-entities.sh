#!/usr/bin/env bash
# Regenerates crates/entity/src from the migrations:
# throwaway Postgres -> run all migrations -> sea-orm-cli generate entity.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

"$root/scripts/with-ephemeral-postgres.sh" bash -euo pipefail -c '
  cargo run --quiet -p migration -- up
  rm -rf crates/entity/src
  sea-orm-cli generate entity \
    --lib \
    --output-dir crates/entity/src \
    --with-copy-enums \
    --date-time-crate chrono \
    --banner-version off
  cargo fmt -p entity
'
echo "entities regenerated in crates/entity/src"
