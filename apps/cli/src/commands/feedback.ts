/**
 * josctl feedback — E3-B dogfooding signal-quality taps (Calendar dogfooding
 * directive: measure signal quality, not parsing mechanics).
 *
 *   josctl feedback <itemType>/<itemId> <useful|noise|missed|incorrect|interruptive> [--note "..."]
 *   josctl feedback --recent
 *
 * NOTE (same Phase-1 pattern as metrics/brief): there is no feedback API
 * route yet, so this connects to the canonical database DIRECTLY via a local
 * pg pool built from DATABASE_URL. Writes go exclusively through
 * recordFeedback from @jehad/core — the append-only service path; there is no
 * update or delete here.
 */

import type { Writable } from "node:stream";
import { Pool } from "pg";
import {
  FEEDBACK_ITEM_TYPES,
  FEEDBACK_VERDICTS,
  isFeedbackItemType,
  isFeedbackVerdict,
  listFeedback,
  recordFeedback,
  type FeedbackItemType,
  type FeedbackVerdict,
  type FeedbackRow,
} from "@jehad/core";

export const FEEDBACK_USAGE =
  `usage: josctl feedback <itemType>/<itemId> <${FEEDBACK_VERDICTS.join("|")}> [--note "..."]\n` +
  `       josctl feedback --recent   (last 20 verdicts)\n` +
  `itemType: ${FEEDBACK_ITEM_TYPES.join("|")}\n`;

export interface FeedbackRecordArgs {
  readonly recent: false;
  readonly itemType: FeedbackItemType;
  readonly itemId: string;
  readonly verdict: FeedbackVerdict;
  readonly note?: string;
}

export interface FeedbackRecentArgs {
  readonly recent: true;
}

export type FeedbackArgs = FeedbackRecordArgs | FeedbackRecentArgs;

export function parseFeedbackArgs(argv: readonly string[]): FeedbackArgs | null {
  const [command, ...rest] = argv.slice(2);
  if (command !== "feedback") return null;
  if (rest.length === 1 && rest[0] === "--recent") return { recent: true };

  const [target, verdict, flag, note] = rest;
  if (target === undefined || verdict === undefined) return null;
  const slash = target.indexOf("/");
  if (slash <= 0 || slash === target.length - 1) return null;
  const itemType = target.slice(0, slash);
  const itemId = target.slice(slash + 1);
  if (!isFeedbackItemType(itemType) || !isFeedbackVerdict(verdict)) return null;
  if (rest.length > 2 && (flag !== "--note" || typeof note !== "string" || note.length === 0)) {
    return null;
  }
  return rest.length > 2
    ? { recent: false, itemType, itemId, verdict, note }
    : { recent: false, itemType, itemId, verdict };
}

/** Injectable pool factory — hermetic tests substitute a fake db. */
export type FeedbackDbFactory = (databaseUrl: string) => {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
};

const defaultFactory: FeedbackDbFactory = (databaseUrl) =>
  new Pool({ connectionString: databaseUrl }) as unknown as ReturnType<FeedbackDbFactory>;

export interface FeedbackCommandDeps {
  readonly databaseUrl: string;
  readonly output?: Writable;
  readonly errOutput?: Writable;
  readonly connect?: FeedbackDbFactory;
  readonly now?: () => Date;
}

export async function runFeedbackCommand(
  argv: readonly string[],
  deps: FeedbackCommandDeps,
): Promise<number> {
  const out = deps.output ?? process.stdout;
  const errOut = deps.errOutput ?? process.stderr;

  const parsed = parseFeedbackArgs(argv);
  if (parsed === null) {
    errOut.write(FEEDBACK_USAGE);
    return 2;
  }

  const db = (deps.connect ?? defaultFactory)(deps.databaseUrl);
  try {
    if (parsed.recent) {
      const rows = await listFeedback(db, { limit: 20 });
      if (rows.length === 0) {
        out.write("no feedback recorded yet\n");
      } else {
        for (const row of rows) out.write(renderFeedbackLine(row) + "\n");
      }
      return 0;
    }
    const { feedback, deduped } = await recordFeedback(
      db,
      { itemType: parsed.itemType, itemId: parsed.itemId, verdict: parsed.verdict, note: parsed.note ?? null },
      { now: deps.now },
    );
    out.write(
      `${JSON.stringify({
        id: feedback.id,
        itemType: feedback.itemType,
        itemId: feedback.itemId,
        verdict: feedback.verdict,
        deduped,
      })}\n`,
    );
    return 0;
  } catch (err) {
    errOut.write(
      `josctl: feedback failed against ${deps.databaseUrl}: ${
        err instanceof Error ? err.message : String(err)
      }\nIs the database migrated and reachable? (pnpm migrate)\n`,
    );
    return 1;
  } finally {
    await db.end();
  }
}

function renderFeedbackLine(row: FeedbackRow): string {
  const note = row.note === null ? "" : `  # ${row.note}`;
  return `${row.createdAt}  ${row.itemType}/${row.itemId}  ${row.verdict}${note}`;
}
