# A′ Spike — chat.db / FDA / Tahoe access (2026-09-18)

Committed-scope entry point of `docs/plans/imessage-gateway.md`. Probes:
`infra/imessage/aprime-probe.mjs` (read-only, `mode=ro`, node:sqlite via `bin/sensor-node`).

## Findings

### 1. FDA is required and sufficient — wrapper pattern works
- Interactive shell **and** plain LaunchAgent: TCC-denied
  (`authorization denied` / `EPERM` on `~/Library/Messages` readdir).
- `bin/sensor-node`: copied brew node binary, rpath-fixed
  (`install_name_tool -add_rpath`), ad-hoc re-signed. After a one-time
  System Settings grant, it reads chat.db under **both** interactive and
  launchd identities. Used by nothing else — the FDA scope is exactly the
  sensor.
- `bin/` is gitignored; the copy is a build step to re-create after node
  upgrades (re-run the rpath + codesign, grant persists per-path — re-verify
  after OS upgrades; part of the Phase A runbook).

### 2. `mode=ro` against the live DB works — `immutable=1` unnecessary
- WAL + SHM present and readable; `journal_mode=wal`.
- Fresh messages become visible on a new read-only connection with no WAL
  mutation (proven twice with real deliveries).
- Per the plan revision: `immutable=1` stays an experimental fallback only;
  snapshot/copy is the escalation path if a macOS update breaks `mode=ro`.

### 3. `attributedBody` is the primary text store on this install
Recent 2000 messages: **406 (20%)** with `text`, **1590 (79.5%)**
attributedBody-ONLY, 1996 (99.8%) with attributedBody. A
`text IS NOT NULL` sensor would miss 4 of 5 messages — **including our own
deliveries** (both probe vectors: `text` null, content in attributedBody).
The owner's warning was directionally right and quantitatively worse than
expected. Phase A's decoder is load-bearing, not an edge case.

### 4. Blob format: old-style `streamtyped` typedstream (not protobuf)
`\x04\x0bstreamtyped\x81\xe8\x03…` — NSKeyedArchiver old-style streaming.
Plaintext UTF-8 is embedded; observed markers: `NSString` object +
content run, `__kIMFileTransferGUIDAttributeName` (attachments),
`__kIMMessagePartAttributeName` (multipart index),
`__kIMBaseWritingDirectionAttributeName` (RTL), inline `U+FFFC` object
replacement for attachments. Marker-scan heuristic extracts text (used in
these probes); Phase A ships a fixture-driven parser per plan §7
(ASCII/Unicode/emoji/RTL/multiline/URLs/long/empty/malformed/unknown) —
correct text or no text, skip+audit on uncertainty.

### 5. Loop-defense primitives confirmed on real rows
`is_from_me = 1` on both E4-chain deliveries (ROWID 216994, 216995);
ROWID monotone cursor base = 216995 at spike close.

### 6. Bonus: real E4 deliverer bug found, fixed, verified
`escapeAppleScriptString` emitted **escaped** quotes in the newline
concatenation (`\" & linefeed & \"`), which AppleScript treats as literal
quote characters *inside* the string — every multi-line iMessage shipped
with literal `" & linefeed & "` text (the first single-line test masked it;
tonight's brief would have been mangled). Fixed to unescaped
`" & linefeed & "` (close-concat-reopen), pinned tests updated, edge agent
rebuilt + restarted, verified round-trip via chat.db decode: real `\n`
newlines in the delivered message. Commit `c3af325`.

### 7. Hermetic-test fix (spillover)
`envOrKeychainTokenProvider` test was host-state-dependent (passed only
while the `jehad-gcalendar` Keychain item was absent — permanently false
since OAuth bootstrap). Parameterized the service name; test probes an
absent item. Same commit.

## Remaining A′ items → Phase A build criteria
Cursor-survives-restart machinery · DB replacement/reset detection ·
loud schema/content-population drift failure · sensor survives
reboot/display-sleep (KeepAlive + `caffeinate` policy) · recovery runbook.
These are sensor-implementation criteria, not substrate unknowns — **the
substrate risk A′ existed to retire is retired.**

## Verdict
Every substrate assumption in `docs/plans/imessage-gateway.md` held or was
corrected by these findings. Phase A (shadow sensor) is unblocked.
