#!/usr/bin/env bash
# M1 practiced restore (plan §7, M1 row; T16): pg_restore a custom-format
# dump into an explicitly named TARGET database (created if missing).
# Safe by default: refuses to restore over the canonical `jehad` database
# without --force. Uses pg_restore --clean --if-exists.
# Usage: infra/dev/restore.sh <dump-file> <target-db> [--force]
#        pnpm restore -- <dump-file> <target-db> [--force]
set -euo pipefail

DATABASE_URL="${DATABASE_URL:-postgres://$(whoami)@localhost:5432/jehad}"

for prefix in "/opt/homebrew" "/usr/local"; do
  bin_dir="${prefix}/opt/postgresql@16/bin"
  if [ -x "${bin_dir}/pg_restore" ]; then
    PATH="${bin_dir}:${PATH}"
  fi
done

for tool in pg_restore psql; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "error: ${tool} not found on PATH or /opt/homebrew/opt/postgresql@16/bin" >&2
    exit 1
  fi
done

if [ "$#" -lt 2 ] || [ "$#" -gt 3 ]; then
  echo "usage: $0 <dump-file> <target-db> [--force]" >&2
  exit 2
fi

DUMP_FILE="$1"
TARGET_DB="$2"
FORCE="${3:-}"

if [ -n "$FORCE" ] && [ "$FORCE" != "--force" ]; then
  echo "usage: $0 <dump-file> <target-db> [--force]" >&2
  exit 2
fi

if [ ! -f "$DUMP_FILE" ]; then
  echo "error: dump file not found: $DUMP_FILE" >&2
  exit 1
fi

if ! [[ "$TARGET_DB" =~ ^[a-z_][a-z0-9_]*$ ]]; then
  echo "error: invalid target database name: ${TARGET_DB}" >&2
  exit 1
fi

if [ "$TARGET_DB" = "jehad" ] && [ "$FORCE" != "--force" ]; then
  echo "error: refusing to restore over the canonical 'jehad' database without --force" >&2
  echo "  to proceed anyway: $0 ${DUMP_FILE} jehad --force" >&2
  exit 1
fi

# connection string for the target: swap the db name in DATABASE_URL's path
TARGET_URL="${DATABASE_URL%%\?*}"
TARGET_URL="${TARGET_URL%/*}/${TARGET_DB}"

if psql --dbname "$DATABASE_URL" --no-psqlrc --tuples-only --command \
  "SELECT 1 FROM pg_database WHERE datname = '${TARGET_DB}'" | grep -q 1; then
  echo "ok: target database '${TARGET_DB}' exists"
else
  psql --dbname "$DATABASE_URL" --no-psqlrc \
    --command "CREATE DATABASE \"${TARGET_DB}\"" >/dev/null
  echo "ok: created database '${TARGET_DB}'"
fi

pg_restore --clean --if-exists --dbname "$TARGET_URL" "$DUMP_FILE"
echo "ok: restored ${DUMP_FILE} → ${TARGET_DB}"
