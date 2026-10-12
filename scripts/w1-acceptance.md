# W1 live acceptance — "Delegated result" scenario B (plan §22 B, §11; ADR-0018)

Human-runnable dogfood sign-off for W1 (attention kernel + outcome producer +
Today). Run top to bottom against the LIVE stack; each step names the exact
command and the observable you must see before moving on. The automated
counterparts (`e2e-scenario-b.integration.test.ts`,
`w1-acceptance.integration.test.ts`) assert the same shapes hermetically; this
sheet proves the live wiring (edge/iMessage/Tailnet/tail latencies).

Preconditions (once):

```sh
brew services start postgresql@16   # if not running
pnpm setup:db                       # creates the local `jehad` database
pnpm build
```

---

## 1. Reconcile, then migrate the live DB

After lane reconciliation (all four W1 branches merged), apply migrations
000…030 to the live database:

```sh
pnpm migrate
```

**Expected:** migrations `029_attention_items` and `030_notification_attention`
apply; a second `pnpm migrate` is a no-op ("already applied", nothing to do).
Then sanity-check the schema shape against the contract:

```sh
psql "$DATABASE_URL" -c "\d attention_items" | grep -E 'fingerprint|UNIQUE'
psql "$DATABASE_URL" -c "SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='notifications'::regclass AND pg_get_constraintdef(oid) LIKE '%attention%'"
```

**Expected:** `attention_items` has `UNIQUE (principal_id, source_type,
source_object_id, fingerprint)`; at least one notifications CHECK mentions
`attention` (kind and source_type widened, migration 030).

## 2. Start the live stack

```sh
pnpm dev                        # api (127.0.0.1:3000) + worker
pnpm --filter @jehad/edge-agent start   # separate terminal; iMessage edge
```

**Expected:** `/healthz` returns `{"ok":true}`; worker startup logs list the
`attention-liveness` workflow (cron `*/5 * * * *`); edge-agent claims nothing
yet (empty queue). `policy.yaml` contains `notifications.autoApproveKinds`
including `attention` and an `attention: {enabled: true, cooldownMinutes: 60}`
section (kill-switch present).

```sh
curl -s http://127.0.0.1:3000/healthz
```

## 3. Delegate a real outcome

```sh
josctl delegate "Draft the weekly review summary and park it for my judgment"
```

**Expected:** prints `outcome <REF> accepted — executor dispatched (run <id>)`.
Note the REF.

## 4. Watch it reach waiting_user — and the item open in-transaction

```sh
josctl ops outcome <REF>
psql "$DATABASE_URL" -c "SELECT kind, fingerprint, state, level, occurrences, change_fingerprint FROM attention_items WHERE source_object_id=(SELECT id FROM outcomes WHERE ref='<REF>')"
```

**Expected:** outcome status `waiting_user`; EXACTLY ONE attention row:
kind `outcome.ready`, fingerprint `outcome:<outcome-id>:ready`, state `open`,
level `inbox`, occurrences `1`. The outcome row's own status is untouched by
the item (durable truth vs attention projection).

```sh
psql "$DATABASE_URL" -c "SELECT type, count(*) FROM events WHERE type LIKE 'attention.%' GROUP BY type"
psql "$DATABASE_URL" -c "SELECT kind, status, source_type, payload->>'content' FROM notifications WHERE kind='attention' ORDER BY created_at DESC LIMIT 1"
```

**Expected:** one `attention.item.opened` event (ids/counts-only payload); one
`kind='attention'` notification, status `approved` (policy auto-approve),
content = the item summary.

## 5. iMessage receipt (delivery projection)

With the edge-agent running and the owner's handle paired, wait one poll
cadence.

**Expected:** iMessage arrives on the owner's phone: item title, summary, and
a `Review in Today: <TODAY_BASE_URL>/ui#item-<id>` line (set `TODAY_BASE_URL`
per `docs/deploy/today-tailnet.md`; no URL line if unset). Delivery is
best-effort: kill the edge before step 5 and the item must STILL be open in
step 6 — then TTL-lapse the notification (or shorten
`notifications.defaultTtlMinutes` in policy for the exercise), confirm the
next `attention-liveness` tick re-enqueues exactly one replacement
(`delivery_attempts` increments, still one row, occurrences unchanged), and
restart the edge to receive it once.

## 6. Today URL check (Tailnet, phone)

On the owner phone, open `https://<host>.<tailnet>.ts.net/ui` (via
`tailscale serve --bg --https=443 http://127.0.0.1:3000` on the host).

**Expected:** the item renders ("ready for your judgment", the outcome title)
with actions; the page sets `Content-Security-Policy: default-src 'none'; …`;
no script tags; hostile strings (if any outcome title ever contained HTML)
appear escaped, never raw. From a NON-owner principal's bearer (if you mint
one), `GET /attention` must not list the item — principal isolation holds over
HTTP too.

## 7. Resolve via the UI

Tap the item's resolve action in Today.

**Expected:** item disappears from the list; then:

```sh
psql "$DATABASE_URL" -c "SELECT state, resolved_by, resolution_reason FROM attention_items WHERE source_object_id=(SELECT id FROM outcomes WHERE ref='<REF>')"
josctl ops outcome <REF>
```

**Expected:** row `state=resolved`, `resolved_by=owner`; outcome STILL
`waiting_user` — resolving the attention item never mutates canonical state.
One new `attention.item.resolved` event.

## 8. Resume, re-park → reopen (recurrence)

```sh
josctl ops decide <REF> approve        # executor resumes: waiting_user → running
# let the executor park again (or re-drive it): running → waiting_user
psql "$DATABASE_URL" -c "SELECT state, occurrences, first_raised_at FROM attention_items WHERE source_object_id=(SELECT id FROM outcomes WHERE ref='<REF>')"
```

**Expected:** SAME row reopens: `state=open`, `occurrences=2`,
`first_raised_at` unchanged (reopen preserves it); a second
`attention.item.opened` event; a second iMessage arrives (new
`change_fingerprint`, past the 60-minute cooldown).

## 9. Feedback tap

Tap a feedback verdict (useful/noise) on the item in Today.

```sh
psql "$DATABASE_URL" -c "SELECT item_type, verdict, created_at FROM feedback WHERE item_type='attention_item' ORDER BY created_at DESC LIMIT 1"
```

**Expected:** one `attention_item` feedback row, principal-scoped to the owner.

## 10. Terminal states close correctly (spot checks)

- Cancel while waiting: `josctl ops outcome <REF>` shows `cancelled` → the
  open item auto-resolves, `resolved_by=producer`,
  `resolution_reason=outcome_cancelled`.
- Drive a different outcome to `failed` → its `outcome.failed` item stays OPEN
  (owner-ack only; nothing auto-resolves it).
- Complete an outcome (verify/waive all criteria, executor → verifying →
  completed) → ZERO open attention rows for it and NO completion notification
  (completed outcomes open no item — invariant 3).

**Expected for all:** as stated; `attention.item.resolved` events carry
ids/counts only.

## 11. Kill-switch

Set `attention.enabled: false` in `policy.yaml`, wait for the next
`attention-liveness` tick (≤5 min).

**Expected:** worker logs show the workflow no-op (kill-switch short-circuit);
no new deliveries. Restore `true` afterwards.

---

Sign-off: steps 1–9 green = scenario B passes end-to-end (delegate → ready →
notify → resolve → reopen → feedback). Record the run (date, REFs, edge
latency, any anomaly) in the W1 wrap-up note.
