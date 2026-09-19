# iMessage Gateway — Phase A Lane Contracts (binding)

Committed scope: Phase A shadow sensor per `docs/plans/imessage-gateway.md`
+ `docs/spikes/a-prime-chatdb.md`. These contracts are the serialized
interface decisions; lanes may not change them unilaterally — propose to
the orchestrator instead.

## Normalization + hash (used identically by Lane C edge and Lane D sensor)

```ts
// canonicalNormalize(text) BEFORE any hashing; NO trimming, NO punctuation rewrite
text.normalize("NFC").replace(/\r\n|\r/g, "\n")
// hash = sha256 hex of the UTF-8 encoding of canonicalNormalize(text)
```

## Decoder interface (Lane A owns `apps/imessage-sensor/src/decoder/**`)

```ts
export type DecodeResult =
  | { ok: true; text: string; parts: number; hasAttachmentPlaceholder: boolean }
  | { ok: false; reason: "malformed" | "unknown-archive"; detail?: string };

/** Decodes an Apple `streamtyped` typedstream attributedBody blob.
 *  Correct text or no text — never partial/guessed output. */
export function decodeAttributedBody(blob: Uint8Array): DecodeResult;
```

Fixture matrix (each = `.bin` fixture + expected result file):
ASCII · Unicode · emoji · RTL · multiline · URLs · very long · empty/null ·
rich formatting · malformed attributedBody · unknown archive encoding.
Blob format facts from the spike: header `\x04\x0bstreamtyped\x81\xe8\x03`,
NSString object + content run, `__kIMFileTransferGUIDAttributeName`,
`__kIMMessagePartAttributeName` (part index), `__kIMBaseWritingDirectionAttributeName`,
inline `U+FFFC` for attachments. 79.5% of recent messages on this host are
attributedBody-only — this decoder is load-bearing.

## Migration 010 — `imessage_sensor` (Lane B owns; sketch is binding shape)

```sql
imessage_transport_events (
  id uuid PK, guid text NOT NULL UNIQUE,        -- idempotency key
  rowid bigint NOT NULL, is_from_me boolean NOT NULL,
  transport_handle text NOT NULL, service text,
  has_text boolean, has_attributed_body boolean,
  decoded_status text NOT NULL,   -- ok | skipped-malformed | skipped-unknown | not-attempted | own-ok
  text_length integer,
  normalized_text_sha256 text,    -- ONLY for is_from_me rows (loop correlation)
  fingerprint_id uuid NULL,       -- set when correlated to sent_message_fingerprints
  observed_at timestamptz NOT NULL, ingested_at timestamptz DEFAULT now()
)
sent_message_fingerprints (
  id uuid PK, notification_id uuid NOT NULL, recipient text NOT NULL,
  rendered_text_sha256 text NOT NULL, delivered_at timestamptz NOT NULL,
  imessage_guid text NULL          -- backfilled by sensor correlation
)
imessage_sensor_state (            -- singleton row
  singleton boolean PK DEFAULT true CHECK (singleton),
  cursor_rowid bigint NOT NULL, db_generation text, schema_fingerprint text,
  health_process text, health_database text, health_decoder text,
  health_cursor text, health_shadow text,   -- each: healthy|degraded|failed
  updated_at timestamptz NOT NULL
)
```

Privacy rule (shadow phase): third-party message CONTENT is never ingested —
metadata, lengths, hashes, decoder status only. Decoded text hash is stored
only for `is_from_me` rows.

## Ingest routes (Lane B owns new routes; auth: `imessage-sensor` principal)

- `POST /harness/imessage/ingest` — body:
  `{ batch: [{guid,rowid,is_from_me,transport_handle,service,has_text,
  has_attributed_body,decoded_status,text_length,normalized_text_sha256?,
  observed_at}], cursor:{rowid,db_generation,schema_fingerprint} }` →
  `{ accepted, duplicates, fingerprint_matches:[{guid,fingerprint_id}] }`.
  Dedupe on `guid` (at-least-once → exactly-once). Cursor upsert in same tx.
- `POST /harness/imessage/health` — `{ health_process, health_database,
  health_decoder, health_cursor, health_shadow, details? }` → 204; state
  upsert + event-log audit.
- New capability `imessage:ingest` (grant machinery exists; do not widen
  `send_channel:imessage`).

## Reply conjunction rule (Lane B owns; ONE implementation, day one)

`kind=reply` is NEVER in `notifications.autoApproveKinds`. Approval rule
(all must hold, else normal approval queue):
`kind=reply AND surface='imessage' AND requesting_principal = paired owner
AND recipient = that principal's verified transport identity AND
conversation_principal = requesting_principal AND third_party_recipient =
false`. Add nullable support columns to `notifications` as needed.
Phases A–C: fixed `EDGE_IMESSAGE_TARGET` satisfies `recipient` (owner's
verified identity).

## Lane C — edge amendments (`apps/edge-agent` + delivered-report handler)

1. Delivered report now includes `rendered_text_sha256` = canonical hash of
   the exact rendered text sent; API handler stores a `sent_message_fingerprints`
   row (notification_id, recipient, hash, delivered_at).
2. `kind=reply` render branch: body = `payload.content`, ≤1500-char
   truncation unchanged, applies to all branches. Test-pinned.
Existing pinned tests stay green (they travel with the code).

## Ownership map (no overlaps)

- **Lane A**: `apps/imessage-sensor/src/decoder/**`, `apps/imessage-sensor/test/decoder/**` (+fixtures). Nothing else.
- **Lane B**: `packages/db/migrations/010*`, `packages/core/src/imessage/**`, `apps/api/src/routes/harness-imessage*`, notifications service reply-rule + tests.
- **Lane C**: `apps/edge-agent/src/**` + tests, `apps/api` delivered-report handler + fingerprints write + test.
- **Lane D (dispatched after A+B integrate)**: `apps/imessage-sensor/src/**` except `decoder/`, runbook, LaunchAgent.

Forbidden everywhere: `reply` in autoApproveKinds · any chat.db/sqlite code
outside `apps/imessage-sensor` (E4 grep pin) · OAuth · new providers ·
weakening pinned tests. Secrets never in git/logs/prompts.

## Completion contract (every lane returns this)

```
WHAT CHANGED / FILES MODIFIED / PUBLIC INTERFACES ADDED/CHANGED /
TESTS ADDED / TEST RESULTS (pnpm test output tail) / ASSUMPTIONS MADE /
KNOWN LIMITATIONS / ARCHITECTURAL CONCERNS / FOLLOW-UP WORK / COMMIT HASH
```
