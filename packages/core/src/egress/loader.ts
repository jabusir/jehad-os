/**
 * egress-policy.yaml loader — policy is data (plan §9; ADR-0012).
 *
 * Parses and validates v1 of the repo-root policy file. Any deviation from
 * the expected shape throws `EgressPolicyError` — a broken policy file fails
 * closed rather than silently allowing egress.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { EgressPolicyError, ModelEgressPolicyRegistry, type EgressPolicyRule } from "./policy.js";

/** Repo-root egress-policy.yaml — same depth from src/ and dist/. */
export function defaultEgressPolicyPath(): string {
  return path.resolve(fileURLToPath(new URL("../../../../egress-policy.yaml", import.meta.url)));
}

const SENSITIVITIES = new Set(["normal", "sensitive", "secret", "*"]);

function requireString(ruleId: string, key: string, value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new EgressPolicyError(`egress-policy.yaml: rule ${ruleId}: ${key} must be a non-empty string`);
  }
  return value;
}

function requireStringArray(ruleId: string, key: string, value: unknown, required: boolean): readonly string[] | undefined {
  if (value === undefined) {
    if (required) throw new EgressPolicyError(`egress-policy.yaml: rule ${ruleId}: ${key} is required`);
    return undefined;
  }
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || v.length === 0)) {
    throw new EgressPolicyError(`egress-policy.yaml: rule ${ruleId}: ${key} must be an array of non-empty strings`);
  }
  return value as readonly string[];
}

function requireBoolean(ruleId: string, key: string, value: unknown): boolean {
  if (typeof value !== "boolean") {
    throw new EgressPolicyError(`egress-policy.yaml: rule ${ruleId}: ${key} must be a boolean`);
  }
  return value;
}

/** Parses + validates the v1 policy document. Strict: unknown keys fail. */
export function parseEgressPolicy(text: string): EgressPolicyRule[] {
  let doc: unknown;
  try {
    doc = parse(text);
  } catch (err) {
    throw new EgressPolicyError(`egress-policy.yaml: invalid YAML (${err instanceof Error ? err.message : String(err)})`);
  }
  if (typeof doc !== "object" || doc === null) throw new EgressPolicyError("egress-policy.yaml: document must be a mapping");
  const root = doc as Record<string, unknown>;
  if (root.version !== 1) throw new EgressPolicyError(`egress-policy.yaml: unsupported version ${JSON.stringify(root.version)} (expected 1)`);
  if (!Array.isArray(root.rules)) throw new EgressPolicyError("egress-policy.yaml: top-level rules must be an array");

  const rules: EgressPolicyRule[] = [];
  for (const [index, raw] of root.rules.entries()) {
    if (typeof raw !== "object" || raw === null) {
      throw new EgressPolicyError(`egress-policy.yaml: rules[${index}] must be a mapping`);
    }
    const entry = raw as Record<string, unknown>;
    const known = new Set(["id", "domainId", "sensitivity", "allowedProviders", "allowedModels", "allowRemote", "requireRedaction"]);
    for (const key of Object.keys(entry)) {
      if (!known.has(key)) throw new EgressPolicyError(`egress-policy.yaml: rules[${index}]: unknown key "${key}" (typos must fail closed)`);
    }
    const id = requireString(`[${index}]`, "id", entry.id);
    const sensitivity = requireString(`[${index}]`, "sensitivity", entry.sensitivity);
    if (!SENSITIVITIES.has(sensitivity)) {
      throw new EgressPolicyError(`egress-policy.yaml: rule ${id}: sensitivity must be normal | sensitive | secret | "*"`);
    }
    rules.push({
      id,
      domainId: requireString(id, "domainId", entry.domainId),
      sensitivity: sensitivity as EgressPolicyRule["sensitivity"],
      allowedProviders: requireStringArray(id, "allowedProviders", entry.allowedProviders, true) ?? [],
      allowedModels: requireStringArray(id, "allowedModels", entry.allowedModels, false),
      allowRemote: requireBoolean(id, "allowRemote", entry.allowRemote),
      requireRedaction: requireBoolean(id, "requireRedaction", entry.requireRedaction),
    });
  }
  return rules;
}

/** Loads the policy file (explicit path > EGRESS_POLICY_YAML > repo root). */
export async function loadEgressPolicyRegistry(
  filePath?: string,
): Promise<ModelEgressPolicyRegistry> {
  const file = filePath ?? (process.env.EGRESS_POLICY_YAML && process.env.EGRESS_POLICY_YAML.length > 0 ? process.env.EGRESS_POLICY_YAML : defaultEgressPolicyPath());
  const text = await readFile(file, "utf8");
  return new ModelEgressPolicyRegistry(parseEgressPolicy(text));
}
