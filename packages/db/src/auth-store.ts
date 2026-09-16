import { createHash } from "node:crypto";

export type PrincipalType = "user" | "harness" | "service" | "workflow";

export const PRINCIPAL_TYPES: readonly PrincipalType[] = [
  "user",
  "harness",
  "service",
  "workflow",
];

export interface Principal {
  id: string;
  type: PrincipalType;
  name: string;
}

export interface PrincipalRecord extends Principal {
  credentialHash: string | null;
}

export interface PrincipalRow {
  id: string;
  type: string;
  name: string;
  credential_hash: string | null;
}

export interface SqlExecutor {
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
}

export function isPrincipalType(value: unknown): value is PrincipalType {
  return (
    typeof value === "string" &&
    (PRINCIPAL_TYPES as readonly string[]).includes(value)
  );
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export async function findPrincipalByCredentialHash(
  db: SqlExecutor,
  credentialHash: string,
): Promise<PrincipalRecord | null> {
  const result = await db.query(
    "SELECT id, type, name, credential_hash FROM principals WHERE credential_hash = $1 LIMIT 1",
    [credentialHash],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  return {
    id: String(row.id),
    type: row.type as PrincipalType,
    name: String(row.name),
    credentialHash:
      row.credential_hash === null || row.credential_hash === undefined
        ? null
        : String(row.credential_hash),
  };
}

export interface UpsertPrincipalInput {
  type: PrincipalType;
  name: string;
  credentialHash: string;
}

export async function upsertPrincipalCredential(
  db: SqlExecutor,
  input: UpsertPrincipalInput,
): Promise<Principal> {
  if (!isPrincipalType(input.type)) {
    throw new TypeError(`invalid principal type: ${String(input.type)}`);
  }
  const result = await db.query(
    `INSERT INTO principals (type, name, credential_hash)
     VALUES ($1, $2, $3)
     ON CONFLICT (name) DO UPDATE SET credential_hash = EXCLUDED.credential_hash
     RETURNING id, type, name`,
    [input.type, input.name, input.credentialHash],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error("upsertPrincipalCredential: no row returned");
  }
  return {
    id: String(row.id),
    type: row.type as PrincipalType,
    name: String(row.name),
  };
}
