// Gmail sync (Phase GMAIL Lane G2 — docs/plans/gmail-sensor-contracts.md
// §3). The cursor pipeline: historyId cursor → users.history.list pages
// (messageAdded) → messages.get → normalize → ONE content-free
// gmail.message.received event per real-world message (§4 — never subject,
// body, snippet, or full addresses) via the existing acceptEvent seam with
// externalId idempotency (`gmail:<messageId>` — one message = one key).
//
// Bootstrap (§3.4): empty cursor → messages.list over the policy window;
// the newest historyId becomes the cursor once the window is fully
// drained. A capped bootstrap keeps the cursor null and converges across
// ticks: deduped refs (events already accepted) skip free via a batched
// existence check, and the per-poll budget counts FETCHED refs — so a
// fully-deduped re-bootstrap is one cheap pass (cursor lands, done), and
// a mixed window processes at most max_messages_per_poll unknown refs per
// tick (bounded work even when nothing is "new" — GC0 dogfood finding). 404 expiry (§3.5): the adapter surfaces GmailHistoryExpired
// (isHistoryExpired below) → cursor cleared → automatic re-bootstrap with
// idempotent re-emit (the calendar 410 precedent).
//
// Partial failure (§3.6): the cursor advances only past history records
// whose messages were fully processed; a per-message fetch/parse failure
// is a terminal skip (audit + count — never partial/guessed output) so a
// poison message cannot stall the inbox. All writes ride the passed
// executor sequentially with the cursor upsert LAST: a crash mid-run
// replays from the old cursor and dedupes (at-least-once → exactly-once).
//
// Health (§3.7): five dimensions (process, credential, cursor, decode,
// quota) written per tick — "0 new messages" is never by itself accepted
// as healthy. No token → clean skip; thrown API errors propagate (error
// name+status only in the tick audit — the calendar pattern).

import { createHash } from "node:crypto";
import { recordAudit, type SqlExecutor } from "../actions/audit.js";
import { acceptEvent, type EventStoreExecutor } from "../events/store.js";
import { LATEST_PAYLOAD_SCHEMA_VERSION } from "../events/catalog.js";
import { idempotencyKeyFor } from "../events/envelope.js";
import { DEFAULT_GMAIL_SENSOR_POLICY, type GmailSensorPolicy } from "../policy/ceiling.js";
import { extractCandidates, landGmailCandidates, normalizeFromAddress } from "./extraction.js";
import { persistGmailContent, type GmailAttachmentRecord } from "./content.js";

/** Event source stamp (the envelope SOURCE_RE admits adapter:<id>). */
export const GMAIL_SOURCE = "adapter:gmail";
/** externalId prefix — one real-world message = one idempotency key (§4.1). */
export const GMAIL_EXTERNAL_ID_PREFIX = "gmail:";
/** The sensor is v1 personal-domain only (§9.1 — OUR inbox). */
export const GMAIL_DOMAIN_KEY = "personal";
/** §4.2: toDomains bounded to 5. */
export const GMAIL_TO_DOMAINS_LIMIT = 5;
/** §4.2: labelIds bounded on the event payload. */
export const GMAIL_LABEL_IDS_LIMIT = 10;
/** §3.2 default cadence hint for the workflow lane (ESCALATE-1). */
export const GMAIL_DEFAULT_POLL_CRON = "*/5 * * * *";

const INBOX_LABEL = "INBOX";
/** sizeClass thresholds (§4.2 size class — coarse, deterministic). */
const SIZE_MEDIUM = 25_000;
const SIZE_LARGE = 100_000;

// ------------------------------------------------------------- adapter port

/** A message reference as carried by history/list responses. */
export interface GmailMessageRef {
  readonly id: string;
  readonly threadId: string;
  /** Present on history messagesAdded records; absent on messages.list refs. */
  readonly labelIds?: readonly string[];
}

export interface GmailMessageListPage {
  readonly messages: readonly GmailMessageRef[];
  readonly nextPageToken: string | null;
  /** Mailbox current historyId — becomes the cursor once the window drains. */
  readonly historyId: number;
}

/** One history.list record: added messages under a monotonic history id. */
export interface GmailHistoryRecord {
  readonly id: number;
  readonly messagesAdded: readonly GmailMessageRef[];
}

export interface GmailHistoryPage {
  readonly records: readonly GmailHistoryRecord[];
  readonly nextPageToken: string | null;
  /** Mailbox current historyId — the cursor when pages are fully consumed. */
  readonly historyId: number;
}

/** messages.get (format=full) result — raw-ish; core normalizes. */
export interface GmailMessage {
  readonly id: string;
  readonly threadId: string;
  readonly labelIds: readonly string[];
  /** Gmail internalDate: epoch milliseconds as a string (verbatim). */
  readonly internalDate: string;
  readonly sizeEstimate: number | null;
  /** Raw From header ("Name <user@domain>" or "user@domain"). */
  readonly from: string | null;
  /** Raw To-header addresses. */
  readonly to: readonly string[];
  readonly subject: string | null;
  /** Gmail-provided snippet (decoded/collapsed at the adapter). */
  readonly snippet: string | null;
  /** text/plain part (adapter applies the deterministic HTML→text fallback). */
  readonly textPlain: string | null;
  /** Attachment METADATA only — bytes are never fetched (ADR-0016). */
  readonly attachments: readonly GmailAttachmentRecord[];
}

/**
 * Structural port: what syncGmail needs from the Gmail SourceAdapter
 * (Lane G1). Read-only by construction — there is no send path to pin
 * because no send path exists in the interface.
 */
/** Structural quota classifier (core never imports the adapter package):
 *  429, or 403 with a rate/quota reason code. */
function isRateLimitedError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { status?: unknown; code?: unknown };
  if (typeof e.status !== "number") return false;
  if (e.status === 429) return true;
  return e.status === 403 && /rateLimit|quota|userRateLimit|dailyLimit|sendAsQuota/i.test(String(e.code ?? ""));
}

export interface GmailSyncPort {
  readonly id: string;
  /** False when no credential is available → clean skip (§3.7). */
  hasToken(): Promise<boolean>;
  /** Bootstrap listing: messages.list with q=newer_than:<days>d (§3.4). */
  listBootstrapMessages(opts: {
    readonly newerThanDays: number;
    readonly pageToken?: string;
  }): Promise<GmailMessageListPage>;
  /** Incremental change feed: history.list?historyTypes=messageAdded (§3.3). */
  listHistory(opts: {
    readonly startHistoryId: number;
    readonly pageToken?: string;
  }): Promise<GmailHistoryPage>;
  getMessage(opts: { readonly id: string }): Promise<GmailMessage>;
}

/**
 * §3.5 404-expiry contract: the adapter surfaces a too-far-behind
 * startHistoryId as an Error named "GmailHistoryExpiredError" (or carrying
 * code GMAIL_HISTORY_EXPIRED). Structural — core never imports the adapter
 * class, mirroring how the calendar kernel stays adapter-agnostic.
 */
export function isHistoryExpired(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "GmailHistoryExpiredError") return true;
  return (err as { code?: unknown }).code === "GMAIL_HISTORY_EXPIRED";
}

// ------------------------------------------------------------- normalization

/** The normalized observation: content-free metadata + bounded text refs. */
export interface NormalizedGmailMessage {
  readonly id: string;
  readonly threadId: string;
  readonly labelIds: readonly string[];
  /** ISO instant from internalDate; null when unparsable (occurredAt falls back to now). */
  readonly internalDateIso: string | null;
  /** Normalized (lowercase) From address; null when unparseable. */
  readonly from: string | null;
  readonly fromDomain: string | null;
  /** Bounded (§4.2: 5), deduped, lowercased recipient domains. */
  readonly toDomains: readonly string[];
  /** sha256 of the normalized From address — identity joins without storing addresses (§4.2). */
  readonly senderSha256: string | null;
  readonly sizeClass: "small" | "medium" | "large";
  readonly subject: string | null;
  readonly snippet: string | null;
  readonly textPlain: string | null;
  readonly attachments: readonly GmailAttachmentRecord[];
}

function domainOfAddress(address: string): string | null {
  const at = address.lastIndexOf("@");
  if (at <= 0 || at === address.length - 1) return null;
  return address.slice(at + 1).toLowerCase();
}

function addressFromHeader(header: string): string | null {
  const angle = /<([^<>@\s]+@[^<>\s]+)>/.exec(header);
  const raw = angle !== null ? angle[1]! : header.trim();
  return /^[^\s@]+@[^\s@]+$/.test(raw) ? raw.toLowerCase() : null;
}

/** Deterministic raw → normalized mapping (the change-detection precedent). */
export function normalizeGmailMessage(raw: GmailMessage): NormalizedGmailMessage {
  const from = normalizeFromAddress(raw.from);
  const toDomains: string[] = [];
  for (const header of raw.to) {
    const address = addressFromHeader(header);
    const domain = address === null ? null : domainOfAddress(address);
    if (domain === null || toDomains.includes(domain)) continue;
    if (toDomains.length >= GMAIL_TO_DOMAINS_LIMIT) break;
    toDomains.push(domain);
  }
  const internalDateMs = Number(raw.internalDate);
  const internalDateIso = Number.isFinite(internalDateMs) && internalDateMs > 0
    ? new Date(internalDateMs).toISOString()
    : null;
  const size = raw.sizeEstimate;
  const sizeClass = size === null ? "small" : size <= SIZE_MEDIUM ? "small" : size <= SIZE_LARGE ? "medium" : "large";
  return {
    id: raw.id,
    threadId: raw.threadId,
    labelIds: raw.labelIds,
    internalDateIso,
    from,
    fromDomain: from === null ? null : domainOfAddress(from),
    toDomains,
    senderSha256: from === null ? null : createHash("sha256").update(from, "utf8").digest("hex"),
    sizeClass,
    subject: raw.subject,
    snippet: raw.snippet,
    textPlain: raw.textPlain,
    attachments: raw.attachments,
  };
}

// ------------------------------------------------------------- sync state

/** Executor subset (keeps @jehad/core dependency-free — event store convention). */
export type GmailDb = EventStoreExecutor & SqlExecutor;

export type GmailHealthDim = "healthy" | "degraded" | "failed";

/** §3.7 health dimensions (jsonb snapshot in gmail_sync_state) + the
 *  ADR-0016 `content` dim (body-lane fetch/parse health; GC0). */
export interface GmailSyncHealth {
  readonly process: GmailHealthDim;
  readonly credential: GmailHealthDim;
  readonly cursor: GmailHealthDim;
  readonly decode: GmailHealthDim;
  readonly quota: GmailHealthDim;
  readonly content: GmailHealthDim;
}

export const GMAIL_HEALTH_DIMS = ["process", "credential", "cursor", "decode", "quota", "content"] as const;

export interface GmailSyncStateRow {
  readonly cursorHistoryId: number | null;
  readonly health: Readonly<Record<string, unknown>> | null;
  readonly lastTickAt: string | null;
}

function isoOrNull(value: unknown): string | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) {
    return new Date(value).toISOString();
  }
  return null;
}

/** The singleton sync-state row; null before the first tick. */
export async function getGmailSyncState(db: GmailDb): Promise<GmailSyncStateRow | null> {
  const result = await db.query(
    `SELECT cursor_history_id, health, last_tick_at FROM gmail_sync_state WHERE id = 'singleton'`,
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  return {
    cursorHistoryId:
      row.cursor_history_id === null || row.cursor_history_id === undefined
        ? null
        : Number(row.cursor_history_id),
    health:
      typeof row.health === "object" && row.health !== null && !Array.isArray(row.health)
        ? (row.health as Record<string, unknown>)
        : null,
    lastTickAt: isoOrNull(row.last_tick_at),
  };
}

/** Persists cursor + health + tick clock (cursor upsert LAST — see header). */
export async function upsertGmailSyncState(
  db: GmailDb,
  state: {
    readonly cursorHistoryId: number | null;
    readonly health: GmailSyncHealth;
    readonly lastTickAt: Date;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO gmail_sync_state (id, cursor_history_id, health, last_tick_at)
     VALUES ('singleton', $1, $2::jsonb, $3::timestamptz)
     ON CONFLICT (id) DO UPDATE SET
       cursor_history_id = EXCLUDED.cursor_history_id,
       health            = EXCLUDED.health,
       last_tick_at      = EXCLUDED.last_tick_at,
       updated_at        = now()`,
    [state.cursorHistoryId, JSON.stringify(state.health), state.lastTickAt.toISOString()],
  );
}

// ------------------------------------------------------------- sync

export interface GmailSyncOptions {
  /** Injection point for tests / determinism; defaults to new Date(). */
  readonly now?: () => Date;
  /** policy.yaml sensors.gmail; absent → fail-safe defaults (§10.3). */
  readonly policy?: GmailSensorPolicy | null;
  /** Audit actor; defaults to the gmail sync system actor. */
  readonly actor?: string;
}

export interface GmailSyncMessageOutcome {
  readonly messageId: string;
  readonly inbox: boolean;
  /** True when this tick created the event row (false = deduped redelivery). */
  readonly accepted: boolean;
  /** The observation event id; null when no event was emitted (non-inbox/failed). */
  readonly eventId: string | null;
  /** Candidates newly landed for this message. */
  readonly candidates: number;
}

export type GmailSyncStatus = "ok" | "no-token" | "disabled";

export interface GmailSyncReport {
  readonly status: GmailSyncStatus;
  readonly mode: "bootstrap" | "incremental" | null;
  readonly messages: readonly GmailSyncMessageOutcome[];
  readonly emitted: number;
  readonly deduped: number;
  readonly nonInboxSkipped: number;
  readonly failed: number;
  /** Inbox messages seen-but-deferred by the flood cap (a lower bound). */
  readonly deferred: number;
  readonly capped: boolean;
  /** True when a 404 forced a re-bootstrap this run (§3.5). */
  readonly fullResync: boolean;
  readonly cursorHistoryId: number | null;
  readonly health: GmailSyncHealth;
}

const GMAIL_SYNC_ACTOR = "system:gmail-sync";

function audit(
  db: GmailDb,
  action: string,
  outputs: Record<string, unknown>,
  actor: string,
): Promise<void> {
  // ids/counts/error-names ONLY — never content (§7; audit precedent).
  return recordAudit(db, {
    actor,
    action,
    reversible: true,
    outputsRef: JSON.stringify(outputs),
  });
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : "UnknownError";
}

interface TickTally {
  messages: GmailSyncMessageOutcome[];
  emitted: number;
  deduped: number;
  nonInbox: number;
  failed: number;
  deferred: number;
  capped: boolean;
  cursorHistoryId: number | null;
  /** ADR-0016 content lane (GC0): attempts vs failures (audit/health only). */
  contentAttempted: number;
  contentFailed: number;
  /** Bounded-work bootstrap rule: refs actually fetched this tick (§3.4). */
  bootstrapProcessed: number;
}

/**
 * Runs one sync pass (§3). Reads (and persists) the gmail_sync_state
 * cursor; emits one content-free observation event per INBOX message;
 * lands deterministic candidates for allowlist senders; writes the
 * multi-dimensional health snapshot. Safe to re-run: identical input
 * produces zero duplicate events (externalId idempotency).
 */
export async function syncGmail(
  db: GmailDb,
  adapter: GmailSyncPort,
  opts: GmailSyncOptions = {},
): Promise<GmailSyncReport> {
  const policy = opts.policy ?? DEFAULT_GMAIL_SENSOR_POLICY;
  const now = opts.now?.() ?? new Date();
  const actor = opts.actor ?? GMAIL_SYNC_ACTOR;

  // §9.4 kill switch: disabled halts without touching anything.
  if (!policy.enabled) {
    await audit(db, "gmail.sync.skip", { reason: "disabled" }, actor);
    return {
      status: "disabled",
      mode: null,
      messages: [],
      emitted: 0,
      deduped: 0,
      nonInboxSkipped: 0,
      failed: 0,
      deferred: 0,
      capped: false,
      fullResync: false,
      cursorHistoryId: null,
      health: {
        process: "healthy",
        credential: "healthy",
        cursor: "degraded",
        decode: "healthy",
        quota: "healthy",
        content: "healthy",
      },
    };
  }

  // §3.7 no-token: clean skip — the tick still stamps health + clock.
  if (!(await adapter.hasToken())) {
    const state = await getGmailSyncState(db);
    const health: GmailSyncHealth = {
      process: "healthy",
      credential: "failed",
      cursor: state?.cursorHistoryId != null ? "healthy" : "degraded",
      decode: "healthy",
      quota: "healthy",
      content: "healthy",
    };
    await upsertGmailSyncState(db, {
      cursorHistoryId: state?.cursorHistoryId ?? null,
      health,
      lastTickAt: now,
    });
    await audit(db, "gmail.sync.skip", { reason: "no-token" }, actor);
    return {
      status: "no-token",
      mode: null,
      messages: [],
      emitted: 0,
      deduped: 0,
      nonInboxSkipped: 0,
      failed: 0,
      deferred: 0,
      capped: false,
      fullResync: false,
      cursorHistoryId: state?.cursorHistoryId ?? null,
      health,
    };
  }

  // Process one INBOX message ref end-to-end: fetch → normalize → event →
  // extraction. Never partial: any failure is a terminal skip (audit +
  // count) before any write happens for that message.
  async function processMessage(ref: GmailMessageRef): Promise<GmailSyncMessageOutcome> {
    let message: NormalizedGmailMessage;
    try {
      message = normalizeGmailMessage(await adapter.getMessage({ id: ref.id }));
    } catch (err) {
      if (isRateLimitedError(err)) {
        // Quota: abort the tick WITHOUT advancing the cursor — skip-and-
        // advance would silently drop these messages forever.
        throw err;
      }
      tally.failed += 1;
      await audit(db, "gmail.sync.message-skipped", {
        messageId: ref.id,
        reason: "fetch-failed",
        error: errorName(err),
      }, actor);
      return { messageId: ref.id, inbox: true, accepted: false, eventId: null, candidates: 0 };
    }
    if (!message.labelIds.includes(INBOX_LABEL)) {
      tally.nonInbox += 1;
      return { messageId: ref.id, inbox: false, accepted: false, eventId: null, candidates: 0 };
    }

    const occurredAt = message.internalDateIso ?? now.toISOString();
    const accepted = await acceptEvent(db, {
      type: "gmail.message.received",
      schemaVersion: LATEST_PAYLOAD_SCHEMA_VERSION,
      source: adapter.id,
      externalId: `${GMAIL_EXTERNAL_ID_PREFIX}${message.id}`,
      occurredAt,
      domainId: GMAIL_DOMAIN_KEY,
      sensitivity: "sensitive",
      payload: {
        messageId: message.id,
        threadRef: message.threadId,
        fromDomain: message.fromDomain,
        toDomains: message.toDomains,
        senderSha256: message.senderSha256,
        receivedAt: occurredAt,
        labelIds: message.labelIds.slice(0, GMAIL_LABEL_IDS_LIMIT),
        sizeClass: message.sizeClass,
      },
      runId: null,
    }, { now: () => now });

    // §6.1 extraction: allowlist senders only; landing is idempotent
    // (deterministic candidate id), so redeliveries are free.
    let candidates = 0;
    const extraction = extractCandidates(message, { extractSenders: policy.extractSenders });
    if (extraction.senderAllowlisted) {
      for (const candidate of extraction.candidates) {
        const landed = await landGmailCandidates(db, message, candidate, accepted.envelope.id, {
          now,
          actor,
          maxCandidatesPerDay: policy.maxCandidatesPerDay,
        });
        if (landed.inserted) candidates += 1;
      }
    }

    // ADR-0016 content lane (GC0): persist the bounded source record when
    // the `gmail.content` class is enabled. Deterministic, model-free,
    // additive: a persist failure never fails the observation event — it
    // degrades the `content` health dim and the row simply stays absent
    // (honest coverage: metadata without body).
    if (policy.contentEnabled) {
      tally.contentAttempted += 1;
      const persisted = await persistGmailContent(db, {
        id: message.id,
        threadId: message.threadId,
        from: message.from,
        to: [],
        subject: message.subject,
        snippet: message.snippet,
        textPlain: message.textPlain,
        internalDate: message.internalDateIso,
        attachments: message.attachments,
      }, {
        policy: {
          enabled: true,
          retentionDays: policy.contentRetentionDays,
          maxBodyBytes: policy.contentMaxBodyBytes,
        },
        observedHistoryId: null,
        now,
        actor,
      });
      if (persisted.status === "failed") {
        tally.contentFailed += 1;
        await audit(db, "gmail.content.persist-failed", {
          messageId: message.id,
          error: persisted.error,
        }, actor);
      }
    }

    const outcome: GmailSyncMessageOutcome = {
      messageId: ref.id,
      inbox: true,
      accepted: accepted.accepted,
      eventId: accepted.envelope.id,
      candidates,
    };
    tally.messages.push(outcome);
    if (accepted.accepted) tally.emitted += 1;
    else tally.deduped += 1;
    return outcome;
  }

  const tally: TickTally = {
    messages: [],
    emitted: 0,
    deduped: 0,
    nonInbox: 0,
    failed: 0,
    deferred: 0,
    capped: false,
    cursorHistoryId: null,
    contentAttempted: 0,
    contentFailed: 0,
    bootstrapProcessed: 0,
  };

  // §3.4 bootstrap: drain the window list. Budget rule (bounded-work, GC0
  // dogfood finding): at most max_messages_per_poll refs are FETCHED per
  // tick — deduped refs (events already in the store, batched existence
  // check) skip free without a fetch, so a fully-deduped re-bootstrap
  // (forced cursor clear, 404-expiry recovery) cannot become unbounded
  // work just because nothing is "new". A capped window converges across
  // ticks: fetched refs become known, so the next tick's budget applies to
  // the next unknown batch. The cursor stays null until the window fully
  // drains (list has no resumable position; setting it early would strand
  // the undrained middle forever). Known-refs skip also means content
  // backfill is not re-run for pre-content messages after a cursor loss —
  // bounded work wins; a manual drain is the owner-correctable path.
  async function runBootstrap(): Promise<void> {
    let completed = true;
    let pageToken: string | undefined;
    let newestHistoryId = 0;
    let processed = 0;
    do {
      const page = await adapter.listBootstrapMessages({
        newerThanDays: policy.bootstrapDays,
        pageToken,
      });
      newestHistoryId = page.historyId;
      const known = await knownEventKeys(page.messages.map((r) => r.id));
      for (const ref of page.messages) {
        if (known.has(idempotencyKeyFor(adapter.id, `${GMAIL_EXTERNAL_ID_PREFIX}${ref.id}`))) continue;
        if (processed >= policy.maxMessagesPerPoll) {
          tally.capped = true;
          completed = false;
          break;
        }
        processed += 1;
        await processMessage(ref);
      }
      if (!completed) break;
      pageToken = page.nextPageToken ?? undefined;
    } while (pageToken !== undefined);
    tally.cursorHistoryId = completed ? newestHistoryId : null;
    tally.bootstrapProcessed = processed;
  }

  /** One batched existence check: which of these message ids already have
   *  accepted events? Keys are minted exactly as acceptEvent does —
   *  idempotencyKeyFor(source, `gmail:<id>`) (sha256; envelope.ts). Fail
   *  open to an empty set is WRONG (refetch storm) — a query failure
   *  propagates (tick fails, cursor untouched, next tick retries). */
  async function knownEventKeys(messageIds: readonly string[]): Promise<Set<string>> {
    if (messageIds.length === 0) return new Set();
    const keys = messageIds.map((id) => idempotencyKeyFor(adapter.id, `${GMAIL_EXTERNAL_ID_PREFIX}${id}`));
    const result = await db.query(
      `SELECT idempotency_key FROM events WHERE idempotency_key = ANY($1::text[])`,
      [keys],
    );
    return new Set((result.rows as { idempotency_key: string }[]).map((r) => r.idempotency_key));
  }

  // §3.3 incremental: walk history pages; the cursor advances only past
  // fully-processed records (§3.6). Non-INBOX refs skip the fetch entirely.
  async function runIncremental(startHistoryId: number): Promise<void> {
    let lastProcessed = startHistoryId;
    let fetched = 0;
    let pageToken: string | undefined;
    let newestHistoryId = startHistoryId;
    do {
      const page = await adapter.listHistory({ startHistoryId, pageToken });
      newestHistoryId = page.historyId;
      let capped = false;
      // Once the budget stops processing, every later inbox ref in THIS
      // fetched page counts as known-deferred (a lower bound — unread
      // pages stay unknown; next tick resumes from lastProcessed).
      let countingDeferred = false;
      const countInbox = (refs: readonly GmailMessageRef[], fromIndex: number): void => {
        for (let i = fromIndex; i < refs.length; i += 1) {
          const ref = refs[i]!;
          if (ref.labelIds === undefined || ref.labelIds.includes(INBOX_LABEL)) {
            tally.deferred += 1;
          }
        }
      };
      for (const record of page.records) {
        if (countingDeferred) {
          countInbox(record.messagesAdded, 0);
          continue;
        }
        let recordDone = true;
        for (let i = 0; i < record.messagesAdded.length; i += 1) {
          const ref = record.messagesAdded[i]!;
          if (ref.labelIds !== undefined && !ref.labelIds.includes(INBOX_LABEL)) {
            tally.nonInbox += 1;
            continue;
          }
          if (fetched >= policy.maxMessagesPerPoll) {
            recordDone = false;
            capped = true;
            countingDeferred = true;
            countInbox(record.messagesAdded, i);
            break;
          }
          fetched += 1;
          await processMessage(ref);
        }
        if (recordDone) {
          lastProcessed = Math.max(lastProcessed, record.id);
        }
      }
      if (capped) {
        tally.capped = true;
        break;
      }
      pageToken = page.nextPageToken ?? undefined;
    } while (pageToken !== undefined);
    tally.cursorHistoryId = tally.capped ? lastProcessed : Math.max(newestHistoryId, lastProcessed);
  }

  const priorState = await getGmailSyncState(db);
  let fullResync = false;
  let mode: "bootstrap" | "incremental";
  if (priorState?.cursorHistoryId == null) {
    mode = "bootstrap";
    await runBootstrap();
  } else {
    mode = "incremental";
    try {
      await runIncremental(priorState.cursorHistoryId);
    } catch (err) {
      if (!isHistoryExpired(err)) throw err;
      // §3.5: cursor too far behind → clear + re-bootstrap this tick; the
      // re-list re-emits nothing new (externalId idempotency).
      fullResync = true;
      mode = "bootstrap";
      tally.messages = [];
      tally.emitted = 0;
      tally.deduped = 0;
      tally.nonInbox = 0;
      tally.failed = 0;
      tally.deferred = 0;
      tally.capped = false;
      tally.cursorHistoryId = null;
      tally.contentAttempted = 0;
      tally.contentFailed = 0;
      tally.bootstrapProcessed = 0;
      await audit(db, "gmail.sync.expired", { priorCursor: priorState.cursorHistoryId }, actor);
      await runBootstrap();
    }
  }

  // §3.7 health snapshot — dims are independent; counts never masquerade
  // as health by themselves. The `content` dim (ADR-0016): degraded when
  // any persist failed, healthy otherwise (no attempts = nothing observed
  // wrong — the class may simply be disabled).
  const health: GmailSyncHealth = {
    process: tally.failed > 0 ? "degraded" : "healthy",
    credential: "healthy",
    cursor: tally.cursorHistoryId !== null ? "healthy" : "degraded",
    decode: tally.failed > 0 ? "degraded" : "healthy",
    quota: tally.deferred > 0 || tally.capped ? "degraded" : "healthy",
    content: tally.contentFailed > 0 ? "degraded" : "healthy",
  };
  await upsertGmailSyncState(db, {
    cursorHistoryId: tally.cursorHistoryId,
    health,
    lastTickAt: now,
  });

  if (tally.capped) {
    await audit(db, "gmail.sync.capped", {
      deferred: tally.deferred,
      cap: policy.maxMessagesPerPoll,
      note: "excess deferred to next tick (cursor held)",
    }, actor);
  }
  await audit(db, "gmail.sync.tick", {
    mode,
    emitted: tally.emitted,
    deduped: tally.deduped,
    nonInbox: tally.nonInbox,
    failed: tally.failed,
    deferred: tally.deferred,
    cursor: tally.cursorHistoryId,
    fullResync,
    contentAttempted: tally.contentAttempted,
    contentFailed: tally.contentFailed,
    bootstrapProcessed: tally.bootstrapProcessed,
  }, actor);

  return {
    status: "ok",
    mode,
    messages: tally.messages,
    emitted: tally.emitted,
    deduped: tally.deduped,
    nonInboxSkipped: tally.nonInbox,
    failed: tally.failed,
    deferred: tally.deferred,
    capped: tally.capped,
    fullResync,
    cursorHistoryId: tally.cursorHistoryId,
    health,
  };
}
