#!/usr/bin/env bash
# M1 nightly backup (plan §7, M1 row; T16): pg_dump the target database in
# custom format (-Fc) into data/backups/ (gitignored via data/ — never into
# git). Default target is the local `jehad` database.
# Usage: pnpm backup | DATABASE_URL=postgres://… infra/dev/backup.sh
set -euo pipefail

DATABASE_URL="${DATABASE_URL:-postgres://$(whoami)@localhost:5432/jehad}"

for prefix in "/opt/homebrew" "/usr/local"; do
  bin_dir="${prefix}/opt/postgresql@16/bin"
  if [ -x "${bin_dir}/pg_dump" ]; then
    PATH="${bin_dir}:${PATH}"
  fi
done

if ! command -v pg_dump >/dev/null 2>&1; then
  echo "error: pg_dump not found on PATH or /opt/homebrew/opt/postgresql@16/bin" >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BACKUP_DIR="${JEHAD_BACKUP_DIR:-${REPO_ROOT}/data/backups}"
mkdir -p "$BACKUP_DIR"

DB_NAME="$(basename "${DATABASE_URL%%\?*}")"
STAMP="$(date +%Y%m%d-%H%M%S)"
DUMP_FILE="${BACKUP_DIR}/${DB_NAME}-${STAMP}.dump"

# defense in depth: backups only ever land inside the gitignored data/ tree
if command -v git >/dev/null 2>&1 \
   && git -C "$REPO_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
   && ! git -C "$REPO_ROOT" check-ignore -q "$DUMP_FILE"; then
  echo "error: ${DUMP_FILE} is not gitignored — refusing to back up into the repo" >&2
  exit 1
fi

# a failed dump must not leave a corrupt file that could later be restored
trap 'rm -f "$DUMP_FILE"' ERR
pg_dump -Fc -f "$DUMP_FILE" "$DATABASE_URL"
trap - ERR

SIZE="$(wc -c < "$DUMP_FILE" | tr -d ' ')"
echo "ok: dumped ${DB_NAME} → ${DUMP_FILE} (${SIZE} bytes)"
if command -v shasum >/dev/null 2>&1; then
  shasum -a 256 "$DUMP_FILE"
fi
