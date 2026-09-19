# iMessage Gateway — Multi-Principal Onboarding Lane Contracts (binding)

Owner directive 2026-09-19: second human principal (Yusra) as general
LLM-over-iMessage user ONLY. Minimal + additive. No household/shared-data
architecture, no general RBAC, no tools/capture, no world-model access for
non-owner principals. All existing pairing/injection/policy/audit/delivery
invariants preserved. Base: integration of Phase A (shadow sensor running).

## Migration 011_imessage_pairing.sql (Lane P)

```sql
transport_identities (
  id uuid PK, principal_id uuid NOT NULL REFERENCES principals,
  transport text NOT NULL CHECK (transport = 'imessage'),
  handle text NOT NULL,           -- canonical: +E.164 or lowercase email
  verified_at timestamptz NOT NULL, last_seen_at timestamptz NOT NULL,
  paired_via_session uuid NOT NULL,
  UNIQUE (transport, handle)      -- one handle → one principal, ever
)
imessage_pairing_sessions (
  id uuid PK, principal_id uuid NOT NULL, purpose text CHECK (purpose IN ('pair','add-handle')),
  code_hash text NOT NULL,        -- sha256 of 6-digit code; code shown ONCE by CLI
  created_at, expires_at NOT NULL DEFAULT (created + 5 min),
  max_total_guesses int NOT NULL DEFAULT 5, guesses_used int NOT NULL DEFAULT 0,
  handle_lockouts jsonb NOT NULL DEFAULT '{}',   -- {handle: wrong_count}
  consumed_at timestamptz NULL, consumed_handle text NULL
)
ALTER TABLE notifications ADD COLUMN recipient text NULL;       -- kind=reply only
ALTER TABLE model_calls ADD COLUMN principal_id uuid NULL, ADD COLUMN surface text NULL;
ALTER TABLE imessage_transport_events ADD COLUMN pairing_attempt_hash text NULL;
-- down path: reverse
```

## Pairing service (packages/core/src/imessage/pairing.ts — Lane P)

- `createPairingSession(db, {principalId, purpose})` → `{ code (returned
  exactly once, never persisted plaintext), sessionId, expiresAt }`.
  Code: crypto-random 6 digits.
- `attemptPairing(db, {handle, attemptHash})` — single active session per
  principal; checks in ONE tx: session unexpired + unconsumed; handle not
  already paired (→ reject, audit); per-handle wrong count < 3; session
  guesses_used < max_total_guesses; `attemptHash === code_hash`.
  Wrong → increment counters, `{paired:false, reason}`. Right → consume
  (consumed_at/handle set — **single-use: code dies on first success**),
  insert transport_identity, audit, create owner notification (kind brief:
  "iMessage pairing: <principal name> paired <handle>"), `{paired:true}`.
- `verifiedHandles(db, principalId)`, `principalForHandle(db, handle)`.

## Heartbeat response carries sensor config (Lane P serves, Lane R consumes)

`POST /harness/imessage/health` now RETURNS:
`{ paired_handles: string[] }` (canonical, all principals).
Sensor behavior contract: non-own rows whose handle ∈ paired_handles →
batch row includes `content` (decoded text; decode-fail → skip content,
decoded_status records it). ALL other non-own rows → include
`pairing_attempt_hash` = sha256(canonicalNormalize(content)) and NEVER
`content`. Own rows unchanged. Sensor never learns pairing codes or
session state. Server-side enforcement regardless of sensor: `content`
on a row whose handle is NOT paired → DISCARD + audit violation.

## Ingest routing (Lane P)

- own row → existing path (loop hash/fingerprint).
- paired handle → principal = principalForHandle; content is TRANSIENT:
  never persisted in any table (no content column exists — keep it that
  way); if principal holds an unexpired `imessage:converse` grant →
  conversation handler (below); else drop content + audit.
- unpaired handle: pairing_attempt_hash → attemptPairing (exact-match
  ONLY — §5.1.1 pre-auth exception: no LLM, no router, no parsing);
  otherwise drop + audit metadata row.

## Conversation (packages/core/src/imessage/conversation.ts — Lane P)

`handleInbound(db, {principalId, handle, text})`:
1. `imessage:converse` grant (unexpired) else silent drop + audit.
2. Budget: `policy.yaml` → `gateway.principals.<name>` =
   `{model, requests_per_hour, cost_per_day}`. Principal ABSENT → deny
   (fail closed). Enforcement: count/cost from model_calls
   (principal_id + surface='imessage', windows hour/day) pre-dispatch;
   over-cap → deny + audit (no model_call row).
3. Context: FIXED system prompt — generic assistant; explicitly no
   world-model, no tools, no commitments/calendar/finance access; nothing
   principal-specific beyond a greeting name. Her text is the user turn.
4. callModel through the existing provider + egress-policy path; record
   model_call with principal_id + surface (follow existing model_calls
   audit shape for prompt/response provenance).
5. Reply: createNotification kind=reply, `recipient` = her canonical
   handle (row column + payload), requesting/conversation principal =
   her, third_party=false, surface imessage → conjunction approves.
Reply length capped to the 1500-char render rule at creation.

## Reply conjunction generalization (notifications/service.ts — Lane P)

Replace owner-hardcoded legs (env target + type='user') with:
- requesting principal has ≥1 verified transport identity, AND
- recipient (row column, fallback payload.recipient) ∈
  verifiedHandles(requestingPrincipal), AND
- conversationPrincipal = requestingPrincipal, third_party = false,
  kind=reply, surface=imessage (unchanged).
EDGE_IMESSAGE_TARGET leaves the reply rule entirely (owner pairs his
handle when he wants converse). Owner briefs/alerts (kind≠reply) still
deliver to the fixed edge default target — unchanged.

## Edge recipient honoring (Lane P)

Claim response may carry `recipient` — server sets it ONLY on approved
kind=reply rows. Deliverer: validated target = recipient ?? Keychain
default (same email/E.164 validators); delivered report's recipient =
actual target used. kind≠reply rows NEVER receive a recipient (server
enforces; edge ignores if present — defense in depth). E4 constraints
untouched: single osascript send, send-only pin, grep pins.

## policy.yaml (Lane P)

```yaml
gateway:
  principals:
    yusra: { model: openrouter/auto-fast, requests_per_hour: 20, cost_per_day: 2.0 }
```
(absent → deny; model id from the existing allowlist)

## josctl (Lane P)

`imessage pair --principal <name> [--add-handle]` (prints code once),
`imessage identities` (list). Principal `yusra` (type user) created via
migration seed or josctl — NO credential minting (transport identity IS
her auth). Grant `imessage:converse` @ resource imessage via the existing
issueGrant ritual, TTL like send_channel.

## Ownership

- Lane P: migration 011, packages/core/src/imessage/{pairing,conversation}.ts,
  service.ts ingest changes, notifications reply rule, harness-imessage
  routes, apps/api claim-route recipient, apps/edge-agent recipient
  honoring + tests, policy.yaml, josctl commands.
- Lane R: apps/imessage-sensor/src/** (not decoder), sensor tests.
- Docs (orchestrator, post-verification): ADR-0013 + gateway plan.

## Forbidden

General RBAC · household domain · tools/capture for conversation ·
world-model reads in any non-owner path · content columns anywhere ·
pairing codes persisted plaintext · weakening any pinned test ·
`reply` in autoApproveKinds · recipient honored for kind≠reply.
