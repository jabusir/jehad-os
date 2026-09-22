#!/usr/bin/env bash
# Wave T one-time host setup: relaunch Messages.app with the imsg-plus
# helper dylib injected so the protocol-level typing indicator works.
#
# PREREQUISITE (owner decision, irreversible-ish): SIP must be disabled on
# this dedicated Mac — Recovery Mode → Terminal → `csrutil disable` → reboot.
# On macOS 26.x, if injection is still blocked after that, boot with
# `csrutil disable` AND `nvram boot-args="amfi_get_out_of_my_way=0x1"`
# (library-validation exception — second explicit security decision).
#
# Usage: apps/edge-agent/scripts/launch-messages-injected.sh
# Idempotent: safe to re-run; re-run after every macOS update.

set -euo pipefail

DYLIB="${DYLIB:-/opt/homebrew/lib/imsg-plus-helper.dylib}"

if [[ ! -f "$DYLIB" ]]; then
  echo "dylib missing at $DYLIB — build it from the imsg-plus checkout:" >&2
  echo "  cd /tmp/opencode/imsg-plus && make build-dylib && cp .build/x86_64-apple-macosx/release/imsg-plus-helper.dylib /opt/homebrew/lib/" >&2
  exit 1
fi

if csrutil status 2>/dev/null | grep -q "enabled"; then
  echo "SIP is ENABLED — injection will not load." >&2
  echo "Recovery Mode → Terminal → csrutil disable → reboot, then re-run." >&2
  exit 1
fi

killall Messages 2>/dev/null || true
sleep 1
DYLD_INSERT_LIBRARIES="$DYLIB" nohup /System/Applications/Messages.app/Contents/MacOS/Messages \
  >> "$HOME/Library/Logs/jehad/messages-injected.log" 2>&1 &
disown
sleep 3

READY="$HOME/Library/Containers/com.apple.MobileSMS/Data/.imsg-plus-ready"
if [[ -f "$READY" ]]; then
  echo "OK: Messages running with the imsg-plus helper (.imsg-plus-ready present)."
else
  echo "WARNING: ready marker not found — check ~/Library/Logs/jehad/messages-injected.log" >&2
  exit 1
fi
