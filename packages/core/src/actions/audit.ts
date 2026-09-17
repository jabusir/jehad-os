// Audit writes for the action lane. Entries go to audit_log and reference
// the records they speak about: action_intent_id / action_attempt_id are
// nullable (plan §7). Honesty rule (ADR-0011 #5, T13): a pre-effect entry
// records intent, never completion — action strings and refs must never
// claim success the system has not observed.

export interface SqlExecutor {
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface AuditEntryInput {
  actor: string;
  action: string;
  reversible: boolean;
  intentId?: string | null;
  attemptId?: string | null;
  grantId?: string | null;
  inputsRef?: string | null;
  outputsRef?: string | null;
}

export async function recordAudit(db: SqlExecutor, entry: AuditEntryInput): Promise<void> {
  await db.query(
    `INSERT INTO audit_log
       (actor, action, inputs_ref, outputs_ref, grant_id, action_intent_id, action_attempt_id, reversible)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      entry.actor,
      entry.action,
      entry.inputsRef ?? null,
      entry.outputsRef ?? null,
      entry.grantId ?? null,
      entry.intentId ?? null,
      entry.attemptId ?? null,
      entry.reversible,
    ],
  );
}
