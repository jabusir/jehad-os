/**
 * Gmail SourceAdapter (Lane G1; docs/plans/gmail-sensor-contracts.md §2–§3)
 * — a READ-ONLY inbox sensor. The only remote operations are GETs on the
 * Gmail v1 read paths (history.list, messages.list, messages.get,
 * getProfile); there is deliberately no send/reply/compose/label/mutation
 * path toward Google — the sensor NEVER sends email, and mail content is
 * data, never authority.
 *
 * Transport is plain fetch (no SDK, no new deps; ADR-0002 vendor isolation).
 * Sync model (§3): incremental via history.list?historyTypes=messageAdded
 * paged from a stored historyId cursor; bootstrap via
 * messages.list?q=newer_than:<window>d whose response historyId becomes the
 * cursor. An expired cursor surfaces as HTTP 404 → GmailApiError with code
 * "historyIdNotFound" (isHistoryExpired) — the caller answers with a full
 * re-sync. The adapter NEVER retries (429 backoff is the caller's job).
 *
 * Token provisioning is the operator's concern (no OAuth flow here):
 * gmailEnvOrKeychainTokenProvider() reads GMAIL_ACCESS_TOKEN first, else the
 * `jehad-gmail` Keychain item — see infra (per-surface tokens, ESCALATE-2).
 * Tokens never enter git, logs, prompts, event payloads, or the DB.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const GMAIL_SOURCE = "adapter:gmail";

const GMAIL_API_BASE = "https://www.googleapis.com/gmail/v1/users/me";

/** Typed Gmail API failure — never a raw fetch/JSON error (§3.7 health). */
export class GmailApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    detail = "",
  ) {
    super(`gmail API error ${status}${code === null ? "" : ` (${code})`}: ${detail.slice(0, 300)}`);
    this.name = "GmailApiError";
  }
}

/**
 * True when the error means the stored historyId cursor is too far behind
 * (HTTP 404, code "historyIdNotFound"; §3.5) — the caller must clear the
 * cursor and re-run the bootstrap (externalId idempotency dedupes).
 */
/** True when the error is a quota/rate limit (HTTP 429, or 403 with a
 *  rate/quota reason) — callers must ABORT the tick without advancing
 *  the cursor; the next tick retries with fresh quota. */
export function isRateLimited(err: unknown): boolean {
  return (
    err instanceof GmailApiError &&
    (err.status === 429 ||
      (err.status === 403 &&
        /rateLimit|quota|userRateLimit|dailyLimit|sendAsQuota/i.test(err.code ?? "")))
  );
}

export function isHistoryExpired(err: unknown): boolean {
  return err instanceof GmailApiError && err.status === 404 && err.code === "historyIdNotFound";
}

export type GmailFetchLike = (
  input: string,
  init?: { readonly method?: string; readonly headers?: Record<string, string> },
) => Promise<Response>;

export interface GmailMessageRef {
  readonly id: string;
  readonly threadId: string;
}

export interface GmailHistoryRecord {
  /** This history record's id (int64 → number). */
  readonly historyId: number;
  /** messageAdded messages in this record (union of `messagesAdded` + `messages`). */
  readonly messages: GmailMessageRef[];
}

export interface GmailHistoryListResult {
  readonly records: GmailHistoryRecord[];
  /** The mailbox's current historyId (the response's top-level historyId) — next cursor. */
  readonly nextHistoryId: number | null;
  readonly nextPageToken: string | null;
}

export interface GmailBootstrapListResult {
  readonly messageIds: GmailMessageRef[];
  /** The list response's top-level historyId — the bootstrap cursor (§3.4). */
  readonly newestHistoryId: number | null;
  readonly nextPageToken: string | null;
}

export interface GmailMessage {
  readonly id: string;
  readonly threadId: string | null;
  readonly labelIds: string[];
  /** Normalized From address (angle brackets/display name stripped); null if unparseable. */
  readonly from: string | null;
  readonly fromDomain: string | null;
  /** Raw Subject header value. */
  readonly subject: string | null;
  /** internalDate in epoch ms; null when absent/malformed. */
  readonly internalDate: number | null;
  /**
   * Body text: the text/plain part; when only text/html exists, its
   * htmlToText() conversion. Null when no textual body survives.
   */
  readonly textPlain: string | null;
  readonly sizeEstimate: number | null;
}

export interface GmailAdapter {
  /** Source string for observations normalized from this adapter. */
  readonly id: string;
  /**
   * history.list?historyTypes=messageAdded from startHistoryId (current
   * mailbox state when null), paged via pageToken.
   */
  historyList(
    startHistoryId: number | null,
    opts?: { readonly pageToken?: string },
  ): Promise<GmailHistoryListResult>;
  /** messages.list?q=newer_than:{windowDays}d, paged (first run / re-sync). */
  bootstrapList(
    windowDays: number,
    opts?: { readonly pageToken?: string },
  ): Promise<GmailBootstrapListResult>;
  /** messages.get?format=full, normalized (bodies are transient data, never persisted). */
  getMessage(id: string): Promise<GmailMessage>;
  /** users.me/profile → current historyId (cursor sanity on first run). */
  profileHistoryId(): Promise<{ historyId: number }>;
}

export function createGmailAdapter(opts: {
  readonly tokenProvider: () => Promise<string> | string;
  readonly fetchImpl?: GmailFetchLike;
}): GmailAdapter {
  const doFetch = opts.fetchImpl ?? (globalThis.fetch as GmailFetchLike);

  async function apiGet(path: string, params: URLSearchParams): Promise<unknown> {
    const token = await opts.tokenProvider();
    if (typeof token !== "string" || token.trim().length === 0) {
      throw new Error("gmail: tokenProvider returned an empty token");
    }
    const response = await doFetch(`${GMAIL_API_BASE}${path}?${params.toString()}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      throw toGmailApiError(response.status, await response.text().catch(() => ""));
    }
    try {
      return await response.json();
    } catch (err) {
      throw new GmailApiError(response.status, "invalidJson", err instanceof Error ? err.message : String(err));
    }
  }

  return {
    id: GMAIL_SOURCE,

    async historyList(startHistoryId, { pageToken } = {}) {
      if (startHistoryId !== null && (!Number.isInteger(startHistoryId) || startHistoryId < 0)) {
        throw new TypeError(`gmail: invalid startHistoryId ${String(startHistoryId)}`);
      }
      const params = new URLSearchParams({ historyTypes: "messageAdded" });
      if (startHistoryId !== null) params.set("startHistoryId", String(startHistoryId));
      if (pageToken !== undefined) params.set("pageToken", pageToken);
      const body = await historyListGet(apiGet, params);
      const rawRecords = Array.isArray(body.history) ? body.history : [];
      const records: GmailHistoryRecord[] = [];
      for (const raw of rawRecords) {
        if (typeof raw !== "object" || raw === null) continue;
        const historyId = asInt((raw as { id?: unknown }).id);
        if (historyId === null) continue;
        records.push({ historyId, messages: collectAddedMessages(raw) });
      }
      return {
        records,
        nextHistoryId: asInt(body.historyId),
        nextPageToken: typeof body.nextPageToken === "string" ? body.nextPageToken : null,
      };
    },

    async bootstrapList(windowDays, { pageToken } = {}) {
      if (!Number.isInteger(windowDays) || windowDays <= 0) {
        throw new TypeError(`gmail: windowDays must be a positive integer (got ${String(windowDays)})`);
      }
      const params = new URLSearchParams({ q: `newer_than:${windowDays}d` });
      if (pageToken !== undefined) params.set("pageToken", pageToken);
      const body = (await apiGet("/messages", params)) as {
        messages?: unknown;
        historyId?: unknown;
        nextPageToken?: unknown;
      };
      const rawMessages = Array.isArray(body.messages) ? body.messages : [];
      const messageIds: GmailMessageRef[] = [];
      for (const raw of rawMessages) {
        const ref = asMessageRef(raw);
        if (ref !== null) messageIds.push(ref);
      }
      return {
        messageIds,
        newestHistoryId: asInt(body.historyId),
        nextPageToken: typeof body.nextPageToken === "string" ? body.nextPageToken : null,
      };
    },

    async getMessage(id: string) {
      if (typeof id !== "string" || id.trim().length === 0) {
        throw new TypeError("gmail: message id must be a non-empty string");
      }
      const params = new URLSearchParams({ format: "full" });
      const body = (await apiGet(`/messages/${encodeURIComponent(id)}`, params)) as {
        id?: unknown;
        threadId?: unknown;
        labelIds?: unknown;
        sizeEstimate?: unknown;
        internalDate?: unknown;
        payload?: unknown;
      };
      if (typeof body.id !== "string" || body.id.length === 0) {
        throw new GmailApiError(200, "invalidResponse", "messages.get response missing id");
      }
      const payload =
        typeof body.payload === "object" && body.payload !== null
          ? (body.payload as {
              headers?: unknown;
              mimeType?: unknown;
              body?: { data?: unknown };
              parts?: unknown[];
            })
          : {};
      const fromRaw = headerValue(payload.headers, "from");
      const from = parseEmailAddress(fromRaw);
      let textPlain = findPartText(payload, "text/plain");
      if (textPlain === null) {
        const html = findPartText(payload, "text/html");
        textPlain = html === null ? null : htmlToText(html);
      }
      return {
        id: body.id,
        threadId: asString(body.threadId),
        labelIds: Array.isArray(body.labelIds)
          ? body.labelIds.filter((l): l is string => typeof l === "string")
          : [],
        from,
        fromDomain: from === null ? null : (from.split("@").pop() ?? "").toLowerCase() || null,
        subject: headerValue(payload.headers, "subject"),
        internalDate: asInt(body.internalDate),
        textPlain,
        sizeEstimate: asInt(body.sizeEstimate),
      };
    },

    async profileHistoryId() {
      const body = (await apiGet("/profile", new URLSearchParams())) as { historyId?: unknown };
      const historyId = asInt(body.historyId);
      if (historyId === null) {
        throw new GmailApiError(200, "invalidResponse", "profile response missing historyId");
      }
      return { historyId };
    },
  };
}

/**
 * Token provider for dogfooding (no OAuth flow here): GMAIL_ACCESS_TOKEN env
 * override first (dev), else the `jehad-gmail` Keychain item via `security
 * find-generic-password` — per-surface tokens (ESCALATE-2), a DIFFERENT
 * service from calendar's `jehad-gcalendar`. The token itself never enters
 * the event log or the database.
 */
export async function gmailEnvOrKeychainTokenProvider(
  keychainService = "jehad-gmail",
): Promise<string> {
  const envToken = process.env.GMAIL_ACCESS_TOKEN;
  if (typeof envToken === "string" && envToken.trim().length > 0) return envToken.trim();
  try {
    const { stdout } = await execFileAsync("security", [
      "find-generic-password",
      "-s",
      keychainService,
      "-w",
    ]);
    const token = stdout.trim();
    if (token.length === 0) throw new Error("empty keychain value");
    return token;
  } catch {
    throw new Error(
      "gmail: no access token — set GMAIL_ACCESS_TOKEN or create the " +
        `Keychain item \`${keychainService}\` (docs/plans/gmail-sensor-contracts.md §2)`,
    );
  }
}

/**
 * Deterministic HTML→text (§6.2, no DOM dependency): drop script/style,
 * <br> and closing <p>/<div> become newlines, strip remaining tags, decode
 * the common entities (&amp; LAST so double-escapes stay single), collapse
 * 2+ blank lines to one, trim. Bounded/truncated use is the caller's.
 */
export function htmlToText(html: string): string {
  let text = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div)\s*>/gi, "\n")
    .replace(/<(p|div)\b[^>]*>/gi, "")
    .replace(/<[^>]*>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
  text = text.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

/**
 * history.list 404 = the startHistoryId is too far behind (§3.5) → the
 * typed expiry ("historyIdNotFound") the sync core answers with a full
 * re-sync. The adapter NEVER retries (§9.3 backoff is the caller's).
 */
async function historyListGet(
  apiGet: (path: string, params: URLSearchParams) => Promise<unknown>,
  params: URLSearchParams,
): Promise<{ history?: unknown; historyId?: unknown; nextPageToken?: unknown }> {
  try {
    return (await apiGet("/history", params)) as {
      history?: unknown;
      historyId?: unknown;
      nextPageToken?: unknown;
    };
  } catch (err) {
    if (err instanceof GmailApiError && err.status === 404) {
      throw new GmailApiError(404, "historyIdNotFound", err.message);
    }
    throw err;
  }
}

function toGmailApiError(status: number, bodyText: string): GmailApiError {
  let code: string | null = null;
  let message = "";
  try {
    const parsed = JSON.parse(bodyText) as {
      error?: { code?: unknown; message?: unknown; errors?: unknown[] };
    };
    const err = parsed.error;
    if (typeof err === "object" && err !== null) {
      if (typeof err.message === "string") message = err.message;
      const first = Array.isArray(err.errors) ? err.errors[0] : undefined;
      const reason =
        typeof first === "object" && first !== null ? (first as { reason?: unknown }).reason : undefined;
      if (typeof reason === "string") code = reason;
      if (code === null && typeof err.code !== "undefined" && err.code !== null) code = String(err.code);
    }
  } catch {
    // Non-JSON body — fall through with the raw text as detail.
  }
  if (message.length === 0) message = bodyText;
  if (status === 404 && code === null) code = "notFound";
  return new GmailApiError(status, code, message);
}

function collectAddedMessages(rawRecord: object): GmailMessageRef[] {
  // Prefer the specific change-type field; union with the legacy `messages`
  // list, deduped by id (order-preserving).
  const byId = new Map<string, GmailMessageRef>();
  const record = rawRecord as { messagesAdded?: unknown; messages?: unknown };
  for (const entry of Array.isArray(record.messagesAdded) ? record.messagesAdded : []) {
    if (typeof entry !== "object" || entry === null) continue;
    const ref = asMessageRef((entry as { message?: unknown }).message);
    if (ref !== null) byId.set(ref.id, ref);
  }
  for (const raw of Array.isArray(record.messages) ? record.messages : []) {
    const ref = asMessageRef(raw);
    if (ref !== null && !byId.has(ref.id)) byId.set(ref.id, ref);
  }
  return [...byId.values()];
}

function asMessageRef(raw: unknown): GmailMessageRef | null {
  if (typeof raw !== "object" || raw === null) return null;
  const id = asString((raw as { id?: unknown }).id);
  const threadId = asString((raw as { threadId?: unknown }).threadId);
  return id !== null && threadId !== null ? { id, threadId } : null;
}

function findPartText(part: unknown, mimeType: string): string | null {
  if (typeof part !== "object" || part === null) return null;
  const p = part as { mimeType?: unknown; body?: { data?: unknown }; parts?: unknown[] };
  if (p.mimeType === mimeType) {
    const decoded = decodeBodyData(p.body?.data);
    if (decoded !== null) return decoded;
  }
  if (Array.isArray(p.parts)) {
    for (const sub of p.parts) {
      const found = findPartText(sub, mimeType);
      if (found !== null) return found;
    }
  }
  return null;
}

/** Gmail part bodies are URL-safe base64 without padding. */
function decodeBodyData(data: unknown): string | null {
  if (typeof data !== "string" || data.length === 0) return null;
  const text = Buffer.from(data, "base64url").toString("utf8");
  return text.length > 0 ? text : null;
}

function headerValue(headers: unknown, lowerName: string): string | null {
  if (!Array.isArray(headers)) return null;
  for (const h of headers) {
    if (typeof h !== "object" || h === null) continue;
    const name = (h as { name?: unknown }).name;
    if (typeof name !== "string" || name.toLowerCase() !== lowerName) continue;
    const value = (h as { value?: unknown }).value;
    if (typeof value === "string") return value;
  }
  return null;
}

function parseEmailAddress(rawHeader: string | null): string | null {
  if (rawHeader === null) return null;
  const angled = rawHeader.match(/<([^<>\s]+)>/);
  const candidate = angled !== null ? angled[1]! : rawHeader.trim().split(/[\s,]+/)[0];
  if (candidate === undefined || !candidate.includes("@")) return null;
  return candidate;
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function asInt(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim().length > 0) {
    const n = Number(v.trim());
    if (Number.isFinite(n)) return n;
  }
  return null;
}
