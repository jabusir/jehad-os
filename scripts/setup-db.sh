#!/usr/bin/env bash
# M0 local Postgres bootstrap: create the `jehad` database (idempotent).
# Assumes Homebrew postgresql@16 installed and running. No Docker (ADR-0001).
set -euo pipefail

DB_NAME="${JEHAD_DB_NAME:-jehad}"

for prefix in "/opt/homebrew" "/usr/local"; do
  bin_dir="${prefix}/opt/postgresql@16/bin"
  if [ -x "${bin_dir}/psql" ]; then
    PATH="${bin_dir}:${PATH}"
  fi
done

if ! command -v psql >/dev/null 2>&1; then
  echo "error: psql not found on PATH" >&2
  echo "  brew install postgresql@16" >&2
  echo "  brew services start postgresql@16" >&2
  echo "  then re-run: pnpm setup:db" >&2
  exit 1
fi

if ! psql --dbname postgres --no-psqlrc --command "SELECT 1" >/dev/null 2>&1; then
  echo "error: cannot reach the local postgres server" >&2
  echo "  brew services start postgresql@16" >&2
  exit 1
fi

if psql --dbname postgres --no-psqlrc --tuples-only --command \
  "SELECT 1 FROM pg_database WHERE datname = '${DB_NAME}'" | grep -q 1; then
  echo "ok: database '${DB_NAME}' already exists"
else
  createdb "${DB_NAME}"
  echo "ok: created database '${DB_NAME}'"
fi
