// Notification queue service (E4 OpenClaw attach). Delivery is queue +
// record ONLY: rows are created behind review/policy (pending unless the kind
// is on the policy auto-approve list), a granted harness principal claims and
// reports delivery through the /harness surface, and every transition writes
// an audit row. The edge owns its own transport; this module never sends
// anything anywhere.
//
// State machine: pending → approved → delivered, with rejected (user refused)
// and expired (delivery window passed) as terminal exits. A claim is a lease,
// not a transition — status stays approved with claimed_at/claimed_by stamped;
// the window is enforced through expires_at.

import { UUID_RE } from "../events/envelope.js";
import { recordAudit } from "../actions/audit.js";
import type { SqlExecutor } from "../actions/audit.js";
import { URGENCY_RANK } from "../review/batching.js";
import {
  DEFAULT_NOTIFICATIONS_CONFIG,
  isNotificationKind,
  loadNotificationsConfig,
  REPLY_NOTIFICATION_KIND,
  type NotificationKind,
  type NotificationsConfig,
} from "./config.js";

export const NOTIFICATION_STATUSES = [
  "pending", "approved", "rejected", "delivered", "expired",
] as const;
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

export const NOTIFICATION_SOURCE_TYPES = ["escalation", "brief", "run", "calendar"] as const;
export type NotificationSourceType = (typeof NOTIFICATION_SOURCE_TYPES)[number];

export interface NotificationRow {
  readonly id: string;
  readonly kind: NotificationKind;
  readonly title: string;
  readonly payload: Record<string, unknown>;
  readonly domainId: string | null;
  readonly status: NotificationStatus;
  readonly sourceType: NotificationSourceType;
  readonly sourceId: string | null;
  readonly createdBy: string;
  readonly approvedBy: string | null;
  readonly approvedAt: string | null;
  readonly claimedAt: string | null;
  readonly claimedBy: string | null;
  readonly deliveredBy: string | null;
  readonly deliveredAt: string | null;
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Delivery surface (gateway §4 reply conjunction; null on legacy rows). */
  readonly surface: string | null;
  /** Principal that requested the reply (paired owner for auto-approval). */
  readonly requestingPrincipalId: string | null;
  /** Principal the reply conversation belongs to. */
  readonly conversationPrincipalId: string | null;
  /** True when the delivery target is outside the owner's verified identity. */
  readonly thirdPartyRecipient: boolean | null;
}

/** The claim projection: exactly what a granted harness may take. */
export interface ClaimedNotification {
  readonly id: string;
  readonly kind: NotificationKind;
  readonly title: string;
  readonly payload: Record<string, unknown>;
  readonly claimedAt: string;
  readonly expiresAt: string;
}

export class NotificationInputError extends Error {
  readonly code = "NOTIFICATION_INPUT_INVALID";
  constructor(message: string) {
    super(message);
    this.name = "NotificationInputError";
  }
}

export class NotificationNotFoundError extends Error {
  readonly code = "NOTIFICATION_NOT_FOUND";
  constructor(readonly notificationId: string) {
    super(`notification ${notificationId} not found`);
    this.name = "NotificationNotFoundError";
  }
}

export class InvalidNotificationStatusError extends Error {
  readonly code = "INVALID_NOTIFICATION_STATUS";
  constructor(readonly notificationId: string, readonly status: string) {
    super(`notification ${notificationId} has status "${status}"`);
    this.name = "InvalidNotificationStatusError";
  }
}

export class NotificationExpiredError extends Error {
  readonly code = "NOTIFICATION_EXPIRED";
  constructor(readonly notificationId: string) {
    super(`notification ${notificationId} is past its delivery window (expires_at)`);
    this.name = "NotificationExpiredError";
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveNow(now?: Date | (() => Date)): () => Date {
  if (now === undefined) return () => new Date();
  return now instanceof Date ? () => now : now;
}

function isSourceType(value: unknown): value is NotificationSourceType {
  return (
    typeof value === "string" &&
    (NOTIFICATION_SOURCE_TYPES as readonly string[]).includes(value)
  );
}

function toIsoOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : value instanceof Date ? value.toISOString() : String(value);
}

function toIso(value: unknown): string {
  return toIsoOrNull(value)!;
}

function rowToNotification(row: Record<string, unknown>): NotificationRow {
  return {
    id: String(row.id),
    kind: String(row.kind) as NotificationKind,
    title: String(row.title),
    payload: isPlainObject(row.payload) ? row.payload : {},
    domainId: row.domain_id === null || row.domain_id === undefined ? null : String(row.domain_id),
    status: String(row.status) as NotificationStatus,
    sourceType: String(row.source_type) as NotificationSourceType,
    sourceId: row.source_id === null || row.source_id === undefined ? null : String(row.source_id),
    createdBy: String(row.created_by),
    approvedBy: row.approved_by === null || row.approved_by === undefined ? null : String(row.approved_by),
    approvedAt: toIsoOrNull(row.approved_at),
    claimedAt: toIsoOrNull(row.claimed_at),
    claimedBy: row.claimed_by === null || row.claimed_by === undefined ? null : String(row.claimed_by),
    deliveredBy: row.delivered_by === null || row.delivered_by === undefined ? null : String(row.delivered_by),
    deliveredAt: toIsoOrNull(row.delivered_at),
    expiresAt: toIso(row.expires_at),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    surface: row.surface === null || row.surface === undefined ? null : String(row.surface),
    requestingPrincipalId:
      row.requesting_principal_id === null || row.requesting_principal_id === undefined
        ? null
        : String(row.requesting_principal_id),
    conversationPrincipalId:
      row.conversation_principal_id === null || row.conversation_principal_id === undefined
        ? null
        : String(row.conversation_principal_id),
    thirdPartyRecipient:
      row.third_party_recipient === null || row.third_party_recipient === undefined
        ? null
        : Boolean(row.third_party_recipient),
  };
}

const NOTIFICATION_COLUMNS = `id, kind, title, payload, domain_id, status, source_type, source_id,
       created_by, approved_by, approved_at, claimed_at, claimed_by,
       delivered_by, delivered_at, expires_at, created_at, updated_at,
       surface, requesting_principal_id, conversation_principal_id, third_party_recipient`;

export interface CreateNotificationInput {
  readonly kind: NotificationKind;
  readonly title: string;
  /** Data for the edge to deliver verbatim — never instructions to this system. */
  readonly payload: Record<string, unknown>;
  readonly domainId?: string | null;
  readonly sourceType: NotificationSourceType;
  readonly sourceId?: string | null;
  readonly createdBy: string;
  /** Overrides the config-derived expiry (absolute). */
  readonly expiresAt?: Date;
  /** Delivery surface (gateway replies: 'imessage'). */
  readonly surface?: string | null;
  /** Reply-rule leg: the principal that requested the reply. */
  readonly requestingPrincipalId?: string | null;
  /** Reply-rule leg: the principal the conversation belongs to. */
  readonly conversationPrincipalId?: string | null;
  /** Reply-rule leg: false = recipient is the owner's verified identity. */
  readonly thirdPartyRecipient?: boolean | null;
}

export interface NotificationServiceOptions {
  readonly config?: NotificationsConfig;
  readonly actor?: string;
  readonly now?: () => Date;
  /**
   * The owner's verified transport identity for the reply conjunction's
   * recipient leg (gateway Phases A–C: the fixed EDGE_IMESSAGE_TARGET).
   * Defaults to process.env.EDGE_IMESSAGE_TARGET; unset fails closed
   * (replies route to the approval queue).
   */
  readonly replyVerifiedRecipient?: string | null;
}

/** What evaluateReplyApproval needs from a notification (input or row shape). */
export interface ReplyApprovalNotification {
  readonly kind: NotificationKind;
  readonly surface?: string | null;
  readonly requestingPrincipalId?: string | null;
  readonly conversationPrincipalId?: string | null;
  readonly thirdPartyRecipient?: boolean | null;
  /** The reply recipient rides payload.recipient (A–C: the fixed target). */
  readonly payload: Record<string, unknown>;
}

/** One entry per failing conjunction leg (empty when all legs hold). */
export type ReplyApprovalLeg =
  | "kind"
  | "surface"
  | "requesting-principal"
  | "recipient"
  | "conversation-principal"
  | "third-party-recipient";

export interface ReplyApprovalDecision {
  readonly approved: boolean;
  readonly failedLegs: readonly ReplyApprovalLeg[];
}

export interface ReplyApprovalOptions {
  /**
   * The owner's verified transport identity (A–C: the fixed
   * EDGE_IMESSAGE_TARGET). Defaults to process.env.EDGE_IMESSAGE_TARGET;
   * unset → the recipient leg fails closed.
   */
  readonly verifiedOwnerRecipient?: string | null;
}

/**
 * The ONE reply auto-approval rule (gateway §4 — no phase ever ships a
 * weaker version): a kind=reply notification is approved at creation ONLY
 * when every conjunction leg holds —
 *
 *   kind                    = reply
 *   AND surface             = imessage
 *   AND requestingPrincipal = a paired owner        (A–C: a user principal)
 *   AND recipient           = that principal's verified transport identity
 *   AND conversationPrincipal = requestingPrincipal
 *   AND thirdPartyRecipient = false
 *
 * Any failing leg routes the notification to the normal approval queue.
 * Phases A–C: the fixed EDGE_IMESSAGE_TARGET IS the owner's verified
 * identity — payload.recipient must equal it when present, and the leg
 * fails closed when no verified recipient is configured at all.
 */
export async function evaluateReplyApproval(
  db: SqlExecutor,
  notification: ReplyApprovalNotification,
  opts: ReplyApprovalOptions = {},
): Promise<ReplyApprovalDecision> {
  const failedLegs: ReplyApprovalLeg[] = [];
  if (notification.kind !== REPLY_NOTIFICATION_KIND) failedLegs.push("kind");
  if (notification.surface !== "imessage") failedLegs.push("surface");

  const requestingPrincipalId = notification.requestingPrincipalId ?? null;
  if (requestingPrincipalId === null) {
    failedLegs.push("requesting-principal");
  } else {
    // A–C: the paired owner IS a user principal (single-owner system;
    // Phase B swaps this leg onto the pairing table's verified identities).
    const principal = await db.query(
      "SELECT type FROM principals WHERE id = $1::uuid",
      [requestingPrincipalId],
    );
    const type = principal.rows[0]?.type;
    if (type !== "user") failedLegs.push("requesting-principal");
  }

  const verifiedRecipient =
    opts.verifiedOwnerRecipient !== undefined
      ? opts.verifiedOwnerRecipient
      : (process.env.EDGE_IMESSAGE_TARGET ?? null);
  if (verifiedRecipient === null || verifiedRecipient === "") {
    failedLegs.push("recipient"); // fail closed: no verified identity to check against
  } else {
    const recipient = notification.payload["recipient"];
    // A–C fixed-target delivery: an absent recipient rides the target by
    // construction; a present recipient must BE the verified identity.
    if (recipient !== undefined && recipient !== null && recipient !== verifiedRecipient) {
      failedLegs.push("recipient");
    }
  }

  const conversationPrincipalId = notification.conversationPrincipalId ?? null;
  if (
    conversationPrincipalId === null ||
    requestingPrincipalId === null ||
    conversationPrincipalId !== requestingPrincipalId
  ) {
    failedLegs.push("conversation-principal");
  }

  if (notification.thirdPartyRecipient !== false) {
    failedLegs.push("third-party-recipient"); // null (unknown) fails closed too
  }

  return { approved: failedLegs.length === 0, failedLegs };
}

/**
 * Creates one notification. Status comes from policy: kinds on the
 * auto-approve list land approved (approved_at stamped, approved_by null —
 * the approval is policy, not a principal); everything else lands pending
 * for user review. kind=reply NEVER consults the auto-approve list — its
 * ONLY approval path is evaluateReplyApproval (the §4 conjunction); any
 * failing leg lands pending like every other reviewed kind.
 */
export async function createNotification(
  db: SqlExecutor,
  input: CreateNotificationInput,
  opts: NotificationServiceOptions = {},
): Promise<NotificationRow> {
  if (!isNotificationKind(input.kind)) {
    throw new NotificationInputError(
      `kind must be one of brief|escalation|custom|calendar-change|reply`,
    );
  }
  if (!isSourceType(input.sourceType)) {
    throw new NotificationInputError(`sourceType must be one of escalation|brief|run|calendar`);
  }
  if (typeof input.title !== "string" || input.title.trim().length === 0 || input.title.length > 280) {
    throw new NotificationInputError("title must be a non-empty string of at most 280 chars");
  }
  if (!isPlainObject(input.payload)) {
    throw new NotificationInputError("payload must be a plain object (jsonb)");
  }
  if (!UUID_RE.test(input.createdBy)) {
    throw new NotificationInputError("createdBy must be a principal id (uuid)");
  }
  if (input.domainId !== undefined && input.domainId !== null && !UUID_RE.test(input.domainId)) {
    throw new NotificationInputError("domainId must be a uuid or null");
  }
  if (input.sourceId !== undefined && input.sourceId !== null && !UUID_RE.test(input.sourceId)) {
    throw new NotificationInputError("sourceId must be a uuid or null");
  }
  if (
    input.surface !== undefined && input.surface !== null &&
    (typeof input.surface !== "string" || input.surface.length === 0 || input.surface.length > 64)
  ) {
    throw new NotificationInputError("surface must be null or a string of 1..64 chars");
  }
  for (const field of ["requestingPrincipalId", "conversationPrincipalId"] as const) {
    const value = input[field];
    if (value !== undefined && value !== null && !UUID_RE.test(value)) {
      throw new NotificationInputError(`${field} must be a uuid or null`);
    }
  }
  if (
    input.thirdPartyRecipient !== undefined && input.thirdPartyRecipient !== null &&
    typeof input.thirdPartyRecipient !== "boolean"
  ) {
    throw new NotificationInputError("thirdPartyRecipient must be null or a boolean");
  }
  const config = opts.config ?? DEFAULT_NOTIFICATIONS_CONFIG;
  const now = opts.now?.() ?? new Date();
  // Reply guard: the kind list is dead to replies — the conjunction is the
  // single approval rule (gateway §4; autoApproveKinds never contains reply).
  const replyDecision =
    input.kind === REPLY_NOTIFICATION_KIND
      ? await evaluateReplyApproval(
          db,
          {
            kind: input.kind,
            surface: input.surface ?? null,
            requestingPrincipalId: input.requestingPrincipalId ?? null,
            conversationPrincipalId: input.conversationPrincipalId ?? null,
            thirdPartyRecipient: input.thirdPartyRecipient ?? null,
            payload: input.payload,
          },
          { verifiedOwnerRecipient: opts.replyVerifiedRecipient },
        )
      : null;
  const autoApproved =
    replyDecision !== null ? replyDecision.approved : config.autoApproveKinds.includes(input.kind);
  const status: NotificationStatus = autoApproved ? "approved" : "pending";
  const expiresAtIso = (
    input.expiresAt ?? new Date(now.getTime() + config.defaultTtlMinutes * 60_000)
  ).toISOString();

  const inserted = await db.query(
    `INSERT INTO notifications (kind, title, payload, domain_id, status, source_type, source_id,
                                created_by, approved_at, expires_at, created_at, updated_at,
                                surface, requesting_principal_id, conversation_principal_id,
                                third_party_recipient)
     VALUES ($1, $2, $3::jsonb, $4::uuid, $5, $6, $7, $8::uuid, $9::timestamptz,
             $10::timestamptz, $11::timestamptz, $11::timestamptz, $12, $13::uuid, $14::uuid, $15)
     RETURNING ${NOTIFICATION_COLUMNS}`,
    [
      input.kind,
      input.title,
      JSON.stringify(input.payload),
      input.domainId ?? null,
      status,
      input.sourceType,
      input.sourceId ?? null,
      input.createdBy,
      autoApproved ? now.toISOString() : null,
      expiresAtIso,
      now.toISOString(),
      input.surface ?? null,
      input.requestingPrincipalId ?? null,
      input.conversationPrincipalId ?? null,
      input.thirdPartyRecipient ?? null,
    ],
  );
  const row = inserted.rows[0];
  if (row === undefined) throw new Error("createNotification: insert returned no row");
  const notification = rowToNotification(row);
  await recordAudit(db, {
    actor: opts.actor ?? `principal:${input.createdBy}`,
    action: "notification.created",
    reversible: true,
    outputsRef: JSON.stringify({
      notificationId: notification.id,
      kind: notification.kind,
      status: notification.status,
      autoApproved,
      sourceType: notification.sourceType,
      sourceId: notification.sourceId,
      ...(replyDecision !== null
        ? { replyRule: replyDecision.approved, replyFailedLegs: replyDecision.failedLegs }
        : {}),
    }),
  });
  return notification;
}

export interface ApproveNotificationInput {
  /** Approving user principal id. */
  readonly approvedBy: string;
  readonly actor?: string;
  readonly now?: () => Date;
}

/** pending → approved. User-only at the API boundary; the queue gates delivery. */
export async function approveNotification(
  db: SqlExecutor,
  notificationId: string,
  input: ApproveNotificationInput,
): Promise<NotificationRow> {
  if (!UUID_RE.test(notificationId)) throw new NotificationNotFoundError(notificationId);
  if (!UUID_RE.test(input.approvedBy)) {
    throw new NotificationInputError("approvedBy must be a principal id (uuid)");
  }
  const now = input.now?.() ?? new Date();
  const updated = await db.query(
    `UPDATE notifications
     SET status = 'approved', approved_by = $2::uuid, approved_at = $3::timestamptz, updated_at = $3::timestamptz
     WHERE id = $1::uuid AND status = 'pending'
     RETURNING ${NOTIFICATION_COLUMNS}`,
    [notificationId, input.approvedBy, now.toISOString()],
  );
  const row = updated.rows[0];
  if (row === undefined) {
    await assertExists(db, notificationId);
  }
  const notification = rowToNotification(row!);
  await recordAudit(db, {
    actor: input.actor ?? `principal:${input.approvedBy}`,
    action: "notification.approved",
    reversible: true,
    outputsRef: JSON.stringify({ notificationId, approvedBy: input.approvedBy }),
  });
  return notification;
}

/** pending → rejected (user refused delivery; terminal). */
export async function rejectNotification(
  db: SqlExecutor,
  notificationId: string,
  input: { actor?: string; now?: () => Date } = {},
): Promise<NotificationRow> {
  if (!UUID_RE.test(notificationId)) throw new NotificationNotFoundError(notificationId);
  const now = input.now?.() ?? new Date();
  const updated = await db.query(
    `UPDATE notifications
     SET status = 'rejected', updated_at = $2::timestamptz
     WHERE id = $1::uuid AND status = 'pending'
     RETURNING ${NOTIFICATION_COLUMNS}`,
    [notificationId, now.toISOString()],
  );
  const row = updated.rows[0];
  if (row === undefined) {
    await assertExists(db, notificationId);
  }
  const notification = rowToNotification(row!);
  await recordAudit(db, {
    actor: input.actor ?? "unknown",
    action: "notification.rejected",
    reversible: false,
    outputsRef: JSON.stringify({ notificationId }),
  });
  return notification;
}

async function assertExists(db: SqlExecutor, notificationId: string): Promise<never> {
  const existing = await db.query(
    "SELECT status FROM notifications WHERE id = $1::uuid",
    [notificationId],
  );
  const row = existing.rows[0];
  if (row === undefined) throw new NotificationNotFoundError(notificationId);
  throw new InvalidNotificationStatusError(notificationId, String(row.status));
}

/** Time-driven housekeeping: pending/approved rows past expires_at → expired. */
export async function expireOverdueNotifications(
  db: SqlExecutor,
  opts: { now?: Date | (() => Date) } = {},
): Promise<readonly string[]> {
  const now = resolveNow(opts.now)();
  const expired = await db.query(
    `UPDATE notifications
     SET status = 'expired', updated_at = $1::timestamptz
     WHERE status IN ('pending', 'approved') AND expires_at <= $1::timestamptz
     RETURNING id`,
    [now.toISOString()],
  );
  const ids = expired.rows.map((row) => String(row.id));
  for (const id of ids) {
    await recordAudit(db, {
      actor: "system:notifications",
      action: "notification.expired",
      reversible: false,
      outputsRef: JSON.stringify({ notificationId: id }),
    });
  }
  return ids;
}

export interface ClaimInput {
  /** Claiming harness principal id. */
  readonly claimedBy: string;
  readonly actor?: string;
  /** Capability-grant id that authorized the claim (audit traceability). */
  readonly grantId?: string | null;
  /** Which capability authorized the claim (E4-S alias audit; optional). */
  readonly grantCapability?: string | null;
  readonly now?: () => Date;
}

/**
 * Claims the next approved, unclaimed, unexpired notification (FIFO) and
 * stamps the claim lease (claimed_at/claimed_by — status stays approved).
 * Overdue rows are swept to expired first (audited). Returns null when there
 * is nothing to deliver. SKIP LOCKED keeps concurrent pollers from grabbing
 * the same row.
 */
export async function claimNextApprovedNotification(
  db: SqlExecutor,
  input: ClaimInput,
): Promise<ClaimedNotification | null> {
  if (!UUID_RE.test(input.claimedBy)) {
    throw new NotificationInputError("claimedBy must be a principal id (uuid)");
  }
  const now = input.now?.() ?? new Date();
  await expireOverdueNotifications(db, { now });
  const claimed = await db.query(
    `UPDATE notifications
     SET claimed_at = $1::timestamptz, claimed_by = $2::uuid, updated_at = $1::timestamptz
     WHERE id = (
       SELECT id FROM notifications
       WHERE status = 'approved' AND claimed_at IS NULL AND expires_at > $1::timestamptz
       ORDER BY created_at ASC, id ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id, kind, title, payload, claimed_at, expires_at`,
    [now.toISOString(), input.claimedBy],
  );
  const row = claimed.rows[0];
  if (row === undefined) return null;
  const notification: ClaimedNotification = {
    id: String(row.id),
    kind: String(row.kind) as NotificationKind,
    title: String(row.title),
    payload: isPlainObject(row.payload) ? row.payload : {},
    claimedAt: toIso(row.claimed_at),
    expiresAt: toIso(row.expires_at),
  };
  await recordAudit(db, {
    actor: input.actor ?? `principal:${input.claimedBy}`,
    action: "notification.claimed",
    reversible: true,
    grantId: input.grantId ?? null,
    outputsRef: JSON.stringify({
      notificationId: notification.id,
      claimedBy: input.claimedBy,
      grantCapability: input.grantCapability ?? null,
    }),
  });
  return notification;
}

export interface MarkDeliveredInput {
  /** Reporting harness principal id. */
  readonly deliveredBy: string;
  readonly actor?: string;
  /** Capability-grant id that authorized the delivery (audit traceability). */
  readonly grantId?: string | null;
  /** Which capability authorized the delivery (E4-S alias audit; optional). */
  readonly grantCapability?: string | null;
  readonly now?: () => Date;
}

/**
 * Records the edge's delivery report: approved → delivered. The claim lease
 * is not required (a fast edge may report before its poll cadence re-reads
 * the row), but the window is: past expires_at the row is expired and can
 * never be marked delivered.
 */
export async function markDelivered(
  db: SqlExecutor,
  notificationId: string,
  input: MarkDeliveredInput,
): Promise<NotificationRow> {
  if (!UUID_RE.test(notificationId)) throw new NotificationNotFoundError(notificationId);
  if (!UUID_RE.test(input.deliveredBy)) {
    throw new NotificationInputError("deliveredBy must be a principal id (uuid)");
  }
  const now = input.now?.() ?? new Date();
  const updated = await db.query(
    `UPDATE notifications
     SET status = 'delivered', delivered_by = $2::uuid, delivered_at = $3::timestamptz, updated_at = $3::timestamptz
     WHERE id = $1::uuid AND status = 'approved' AND expires_at > $3::timestamptz
     RETURNING ${NOTIFICATION_COLUMNS}`,
    [notificationId, input.deliveredBy, now.toISOString()],
  );
  const row = updated.rows[0];
  if (row === undefined) {
    const existing = await db.query(
      "SELECT status, expires_at FROM notifications WHERE id = $1::uuid",
      [notificationId],
    );
    const current = existing.rows[0];
    if (current === undefined) throw new NotificationNotFoundError(notificationId);
    const status = String(current.status);
    const expiredAt = toIso(current.expires_at);
    if (status === "approved" && new Date(expiredAt).getTime() <= now.getTime()) {
      await db.query(
        `UPDATE notifications SET status = 'expired', updated_at = $2::timestamptz
         WHERE id = $1::uuid AND status = 'approved'`,
        [notificationId, now.toISOString()],
      );
      await recordAudit(db, {
        actor: "system:notifications",
        action: "notification.expired",
        reversible: false,
        outputsRef: JSON.stringify({ notificationId }),
      });
      throw new NotificationExpiredError(notificationId);
    }
    throw new InvalidNotificationStatusError(notificationId, status);
  }
  const notification = rowToNotification(row);
  await recordAudit(db, {
    actor: input.actor ?? `principal:${input.deliveredBy}`,
    action: "notification.delivered",
    reversible: false,
    grantId: input.grantId ?? null,
    outputsRef: JSON.stringify({
      notificationId,
      deliveredBy: input.deliveredBy,
      grantCapability: input.grantCapability ?? null,
    }),
  });
  return notification;
}

/** Explicit expiry (admin/kill path): pending|approved → expired. */
export async function expireNotification(
  db: SqlExecutor,
  notificationId: string,
  input: { actor?: string; now?: () => Date } = {},
): Promise<NotificationRow> {
  if (!UUID_RE.test(notificationId)) throw new NotificationNotFoundError(notificationId);
  const now = input.now?.() ?? new Date();
  const updated = await db.query(
    `UPDATE notifications
     SET status = 'expired', updated_at = $2::timestamptz
     WHERE id = $1::uuid AND status IN ('pending', 'approved')
     RETURNING ${NOTIFICATION_COLUMNS}`,
    [notificationId, now.toISOString()],
  );
  const row = updated.rows[0];
  if (row === undefined) {
    await assertExists(db, notificationId);
  }
  const notification = rowToNotification(row!);
  await recordAudit(db, {
    actor: input.actor ?? "system:notifications",
    action: "notification.expired",
    reversible: false,
    outputsRef: JSON.stringify({ notificationId }),
  });
  return notification;
}

export interface ListNotificationsFilters {
  readonly status?: NotificationStatus;
  readonly kind?: NotificationKind;
  readonly limit?: number;
}

/** User-side listing (GET /notifications), newest first. */
export async function listNotifications(
  db: SqlExecutor,
  filters: ListNotificationsFilters = {},
): Promise<readonly NotificationRow[]> {
  const limit = filters.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new NotificationInputError("limit must be an integer in [1, 500]");
  }
  const where: string[] = [];
  const values: unknown[] = [];
  if (filters.status !== undefined) {
    if (!(NOTIFICATION_STATUSES as readonly string[]).includes(filters.status)) {
      throw new NotificationInputError(`unknown status ${String(filters.status)}`);
    }
    values.push(filters.status);
    where.push(`status = $${values.length}`);
  }
  if (filters.kind !== undefined) {
    if (!isNotificationKind(filters.kind)) {
      throw new NotificationInputError(`unknown kind ${String(filters.kind)}`);
    }
    values.push(filters.kind);
    where.push(`kind = $${values.length}`);
  }
  values.push(limit);
  const result = await db.query(
    `SELECT ${NOTIFICATION_COLUMNS} FROM notifications
     ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY created_at DESC, id DESC
     LIMIT $${values.length}`,
    values,
  );
  return result.rows.map(rowToNotification);
}

// ------------------------------------------------------------- producers

const NOTIFICATIONS_PRINCIPAL_UPSERT = `
  WITH ins AS (
    INSERT INTO principals (type, name) VALUES ('service', $1)
    ON CONFLICT (name) DO NOTHING
    RETURNING id
  )
  SELECT id FROM ins
  UNION ALL
  SELECT id FROM principals WHERE name = $1
  LIMIT 1
`;

async function resolveServicePrincipal(
  db: SqlExecutor,
  name: string,
): Promise<string> {
  const principal = await db.query(NOTIFICATIONS_PRINCIPAL_UPSERT, [name]);
  const id = principal.rows[0]?.id;
  if (id === undefined) {
    throw new Error(`resolveServicePrincipal: could not resolve ${name}`);
  }
  return String(id);
}

export interface BriefNotificationInput {
  /** "Morning brief" | "Evening close" — the delivery title. */
  readonly title: string;
  /** The rendered brief text, delivered verbatim by the edge. */
  readonly content: string;
  readonly artifactId: string;
  readonly domainKey?: string;
  readonly config?: NotificationsConfig;
  readonly now?: Date | (() => Date);
}

/**
 * Producer hook for the briefs lane: persists a kind=brief notification next
 * to the artifact (auto-approved per policy). Called from
 * packages/core/src/briefs/service.ts behind opts.notify — one line there.
 */
export async function enqueueBriefNotification(
  db: SqlExecutor,
  input: BriefNotificationInput,
): Promise<NotificationRow> {
  const domainKey = input.domainKey ?? "personal";
  const domain = await db.query("SELECT id FROM domains WHERE key = $1", [domainKey]);
  const domainId = domain.rows[0]?.id;
  if (domainId === undefined) {
    throw new NotificationInputError(`domain "${domainKey}" is not seeded`);
  }
  const createdBy = await resolveServicePrincipal(db, "service/briefs");
  return createNotification(
    db,
    {
      kind: "brief",
      title: input.title,
      payload: { artifactId: input.artifactId, content: input.content },
      domainId: String(domainId),
      sourceType: "brief",
      sourceId: input.artifactId,
      createdBy,
    },
    { config: input.config, actor: "service:briefs", now: resolveNow(input.now) },
  );
}

export interface EscalationNotificationInput {
  readonly escalationId: string;
  readonly runId: string;
  readonly reason: string;
  readonly urgency: string | null;
  readonly consequenceOfWaiting?: string | null;
  readonly estHumanMinutes?: number | null;
  readonly domainId: string;
  /** The blocked run's principal — truthful provenance for created_by. */
  readonly createdBy: string;
  readonly config?: NotificationsConfig;
  readonly now?: Date | (() => Date);
}

/**
 * Producer hook for the escalation lane: enqueues a kind=escalation
 * notification only when urgency >= the configured threshold (default high).
 * Pending by policy — escalation delivery always goes through user review.
 * Runs inside the caller's transaction (escalations/service.ts raise path).
 */
export async function enqueueEscalationNotification(
  db: SqlExecutor,
  input: EscalationNotificationInput,
): Promise<NotificationRow | null> {
  const config = input.config ?? (await loadNotificationsConfig());
  const urgencyRank = input.urgency === null ? 0 : (URGENCY_RANK[input.urgency] ?? 0);
  const thresholdRank = URGENCY_RANK[config.escalationMinUrgency] ?? 0;
  if (urgencyRank < thresholdRank) return null;
  return createNotification(
    db,
    {
      kind: "escalation",
      title: `Escalation: ${input.reason}${input.urgency !== null ? ` (${input.urgency})` : ""}`,
      payload: {
        escalationId: input.escalationId,
        runId: input.runId,
        reason: input.reason,
        urgency: input.urgency,
        consequenceOfWaiting: input.consequenceOfWaiting ?? null,
        estHumanMinutes: input.estHumanMinutes ?? null,
      },
      domainId: input.domainId,
      sourceType: "escalation",
      sourceId: input.escalationId,
      createdBy: input.createdBy,
    },
    { config, actor: "internal:escalations", now: resolveNow(input.now) },
  );
}

export interface CalendarChangeNotificationInput {
  /** Pre-composed by the calendar sync lane, e.g. `Standup: moved to 2026-09-18 09:00 UTC`. */
  readonly title: string;
  /** The disruptive change itself (what the edge delivers verbatim). */
  readonly change: {
    readonly changeClass: "start_end_changed" | "cancelled";
    readonly summary: string;
    readonly start: string | null;
    readonly end: string | null;
    readonly previousStart: string | null;
    readonly previousEnd: string | null;
  };
  /** Provenance: which sensor observation produced this notification. */
  readonly provenance: {
    readonly eventId: string;
    readonly googleEventId: string;
    readonly calendarId: string;
  };
  readonly domainKey?: string;
  readonly config?: NotificationsConfig;
  readonly now?: Date | (() => Date);
}

/**
 * Producer hook for the calendar lane (E4-S): persists a kind=calendar-change
 * notification for a DISRUPTIVE near-term change. The 48h filter lives in
 * the caller (calendar sync) — this hook records, never decides. The kind is
 * on the policy auto-approve list; that auto-approve plus the 48h filter IS
 * the noise gate (created/updated changes ride the morning brief instead).
 */
export async function enqueueCalendarChangeNotification(
  db: SqlExecutor,
  input: CalendarChangeNotificationInput,
): Promise<NotificationRow> {
  const domainKey = input.domainKey ?? "personal";
  const domain = await db.query("SELECT id FROM domains WHERE key = $1", [domainKey]);
  const domainId = domain.rows[0]?.id;
  if (domainId === undefined) {
    throw new NotificationInputError(`domain "${domainKey}" is not seeded`);
  }
  const createdBy = await resolveServicePrincipal(db, "service/calendar-sync");
  return createNotification(
    db,
    {
      kind: "calendar-change",
      title: input.title,
      payload: {
        change: { ...input.change },
        provenance: { ...input.provenance, source: "calendar-sync" },
      },
      domainId: String(domainId),
      sourceType: "calendar",
      sourceId: input.provenance.eventId,
      createdBy,
    },
    { config: input.config, actor: "service:calendar-sync", now: resolveNow(input.now) },
  );
}
