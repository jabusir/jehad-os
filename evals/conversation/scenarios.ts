import { readFileSync } from "node:fs";
import { parse } from "yaml";
import type { LedgerContainsPin } from "./assertions.js";

/** §22: which turn-orchestration core a scenario drives. "legacy" is the
 * route→interpret→answer pipeline at HEAD; "single" is the §22 single-author
 * cognitive loop (envelope rounds + truth verification). Defaults to
 * "legacy" while the §22.14 gateway.routing flag exists. */
export type ScenarioPath = "legacy" | "single";

/** §22: legacy pass kinds are classified by prompt markers (they die per
 * §22.11); single-path kinds ("cognitive" = the model call for round N,
 * whose output IS the envelope JSON; "verify" = the §22.9 truth-verifier
 * call) are matched by round index — script order is dispatch order. */
export type ScriptPass = "route" | "interpret" | "answer" | "cognitive" | "verify";

/** §22.15(b): a scripted read result injected at the tool boundary. When the
 * single path executes a read of `tool`, the override supplies `result` (the
 * RESULT OBJECT, verbatim) directly, bypassing the DB-backed read tool — the
 * only way to script shapes the live tool never emits (G1's sparse variant:
 * {otherOpenCount: 7} with no items). Overrides are consumed in order per
 * tool (first unconsumed match wins, then it is spent), so repeated reads of
 * the same tool get distinct scripted results. */
export interface ReadOverride {
  readonly tool: string;
  readonly result: unknown;
}

export interface ScriptedPass {
  readonly pass: ScriptPass;
  readonly output: string;
}

export interface ScenarioTurn {
  readonly user: string;
  readonly modelScript: readonly ScriptedPass[];
}

/** C11 seed: open the nightly calibration item (via the calibration service,
 * like the service integration tests) with prompt_sent_at = the given ISO
 * instant. The runner derives the owner-local period_date from that instant,
 * so a prompt at 20:30 PT is eligible for turns later the same evening. */
export interface SeedCalibrationItem {
  readonly promptSentAt: string;
}

/** C11 seed: one gmail_messages row (ADR-0016 content store). ageHours is
 * relative to the scenario clock, so fixtures stay inside the 7-day
 * retention window regardless of wall-clock time. */
export interface SeedGmailMessage {
  readonly from: string;
  readonly subject: string;
  readonly body: string;
  readonly ageHours: number;
}

/** §22 seed: a pending proposal parked with a KNOWN id, so scenarios can
 * script `proposal_resolutions` against it deterministically (production
 * ids are random; scenarios pin the fixture). */
export interface SeedPendingProposal {
  readonly type: string;
  readonly id: string;
  readonly payload: unknown;
  readonly offered?: string;
}

/** C11 seed block — state the scenario needs BEFORE turn 1. */
export interface ScenarioSeed {
  readonly calibrationItem?: SeedCalibrationItem;
  readonly gmailMessages?: readonly SeedGmailMessage[];
  readonly pendingProposal?: SeedPendingProposal;
}

export interface Scenario {
  readonly id: string;
  readonly description: string;
  readonly principal: string;
  readonly requires: readonly string[];
  /** §22: "legacy" (default — route/interpret/answer scripting) or
   * "single" (cognitive/verify scripting, round-indexed). */
  readonly path?: ScenarioPath;
  /** §22.15(b): scenario-level read-result overrides for the single path
   * (see ReadOverride). Requires path: "single". */
  readonly readOverrides?: readonly ReadOverride[];
  /** C11: ISO instant of turn 1 (overrides the 2026-09-21 default anchor).
   * One turn per minute from there, same as the default. */
  readonly clock?: string;
  readonly seed?: ScenarioSeed;
  readonly turns: readonly ScenarioTurn[];
  readonly expectations: ScenarioExpectations;
}

export interface DbPin {
  readonly sql: string;
  readonly expectOne: boolean;
  readonly expectZero: boolean;
}

/** C11 (intelligence-reset §6): a deterministic-reply marker pin — counts
 * `imessage.converse.replied` audit rows whose outputs_ref carries
 * `deterministic = <marker>`, across the WHOLE scenario. Model replies carry
 * no deterministic marker, so expect_zero on e.g. "calibration-missed" pins
 * "this turn class never terminates deterministically" without pinning copy. */
export interface AuditMarkerPin {
  readonly marker: string;
  readonly expectOne: boolean;
  readonly expectZero: boolean;
}

export interface ScenarioExpectations {
  readonly routedTools?: readonly string[];
  readonly routedNone?: boolean;
  readonly replyContains?: readonly string[];
  readonly replyNotContains?: readonly string[];
  readonly dbPins?: readonly DbPin[];
  /** W6(c) invariant 15: the final reply must not carry a persistence claim
   * (noted/saved/remember/tracking — PERSISTENCE_CLAIM_RE) unless a db pin
   * demonstrates a durable write this scenario. */
  readonly noPersistenceClaimWithoutWrite?: boolean;
  /** W6(a/R8): exact count of `imessage.converse.interpret` audit rows the
   * interpreter's caller must emit for the final turn. */
  readonly interpretAudits?: number;
  /** C11: needles that must be absent from EVERY turn's delivered reply
   * (machinery vocabulary, canned acks) — not just the final turn. Turns
   * that produced no reply are failed separately by the final-turn check. */
  readonly everyTurnNotContains?: readonly string[];
  /** C11: deterministic-reply marker pins over the scenario (see
   * AuditMarkerPin). */
  readonly auditMarkers?: readonly AuditMarkerPin[];
  /** C11: needles that must appear in the final turn's answer-pass PROMPT
   * (prompt-level pins: persona fragment, self-brief lines). Checked over
   * every prompt the runner classified as the answer pass, final turn. */
  readonly answerPromptContains?: readonly string[];
  /** C11: needles that must NOT appear in the final turn's answer prompts. */
  readonly answerPromptNotContains?: readonly string[];
  /** §22: the final turn's typed ledger must contain an entry with this
   * opType AND status ({op_type, status} in yaml). Executed, failed, and
   * rejected entries are all pinning targets (§22.9). Single-path
   * observation; the legacy path observes an empty ledger. */
  readonly ledgerContains?: readonly LedgerContainsPin[];
  /** §22: lower/upper bound on the final turn's cognitive round count
   * (§22.5 caps a turn at 3 rounds; G1's sparse variant pins ≥2). */
  readonly roundsAtLeast?: number;
  readonly roundsAtMost?: number;
  /** §22: the final turn's structured intent enum (§22.2 — question|
   * directive|preference|correction|feedback|delegation|capability|chat)
   * must equal this value. Legacy turns observe null and fail the pin. */
  readonly intentIs?: string;
}

export interface ScenarioFile {
  readonly version: 1;
  readonly scenarios: readonly Scenario[];
}

export class ScenarioFormatError extends Error {}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

function stringArray(value: unknown, where: string, errors: string[]): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || !value.every(isNonEmptyString)) {
    errors.push(`${where}: must be a non-empty array of non-empty strings`);
    return undefined;
  }
  return value as readonly string[];
}

function isReadOnlySql(sql: string): boolean {
  const body = sql.replace(/;\s*$/, "").trim();
  if (body.includes(";")) return false;
  return /^(select|with)\b/i.test(body);
}

function parseDbPin(value: unknown, where: string, errors: string[]): DbPin | undefined {
  if (!isObject(value)) {
    errors.push(`${where}: must be an object`);
    return undefined;
  }
  const sql = value["sql"];
  if (!isNonEmptyString(sql)) {
    errors.push(`${where}.sql: must be a non-empty string`);
    return undefined;
  }
  if (!isReadOnlySql(sql)) {
    errors.push(`${where}.sql: must be a single read-only SELECT statement (${sql})`);
    return undefined;
  }
  const expectOne = value["expect_one"] === true;
  const expectZero = value["expect_zero"] === true;
  if (expectOne === expectZero) {
    errors.push(`${where}: exactly one of expect_one / expect_zero must be true`);
    return undefined;
  }
  return { sql, expectOne, expectZero };
}

function parseTurns(
  value: unknown,
  where: string,
  errors: string[],
  path: ScenarioPath,
): readonly ScenarioTurn[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`${where}: must be a non-empty array of turns`);
    return undefined;
  }
  const turns: ScenarioTurn[] = [];
  for (const [index, rawTurn] of value.entries()) {
    const turnWhere = `${where}[${index}]`;
    if (!isObject(rawTurn)) {
      errors.push(`${turnWhere}: must be an object`);
      continue;
    }
    const user = rawTurn["user"];
    if (!isNonEmptyString(user)) {
      errors.push(`${turnWhere}.user: must be a non-empty string`);
      continue;
    }
    const rawScript = rawTurn["modelScript"];
    if (!Array.isArray(rawScript)) {
      errors.push(`${turnWhere}.modelScript: must be an array of {pass, output} (empty = deterministic turn, zero dispatches expected)`);
      continue;
    }
    const script: ScriptedPass[] = [];
    let scriptOk = true;
    for (const [passIndex, rawPass] of rawScript.entries()) {
      const passWhere = `${turnWhere}.modelScript[${passIndex}]`;
      if (!isObject(rawPass)) {
        errors.push(`${passWhere}: must be an object`);
        scriptOk = false;
        continue;
      }
      const pass = rawPass["pass"];
      const output = rawPass["output"];
      // §22: the pass vocabulary is split by path — route/interpret/answer
      // are the legacy prompt-marker passes (they die per §22.11);
      // cognitive/verify are the single path's round-indexed kinds.
      if (pass === "cognitive" || pass === "verify") {
        if (path !== "single") {
          errors.push(`${passWhere}.pass: "${pass}" requires scenario path: "single"`);
          scriptOk = false;
          continue;
        }
      } else if (pass === "route" || pass === "interpret" || pass === "answer") {
        if (path !== "legacy") {
          errors.push(`${passWhere}.pass: "${pass}" is a legacy-path kind and requires path: "legacy" (single-path scripts use cognitive/verify)`);
          scriptOk = false;
          continue;
        }
      } else {
        errors.push(`${passWhere}.pass: must be "route", "interpret", "answer", "cognitive", or "verify"`);
        scriptOk = false;
        continue;
      }
      if (typeof output !== "string") {
        errors.push(`${passWhere}.output: must be a string`);
        scriptOk = false;
        continue;
      }
      script.push({ pass, output });
    }
    if (scriptOk) turns.push({ user, modelScript: script });
  }
  return turns.length === value.length ? turns : undefined;
}

const isIsoInstant = (value: string): boolean => {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
};

function parseIsoString(value: unknown, where: string, errors: string[]): string | undefined {
  if (!isNonEmptyString(value) || !isIsoInstant(value)) {
    errors.push(`${where}: must be an ISO-8601 instant (e.g. 2026-09-22T03:45:00.000Z)`);
    return undefined;
  }
  return value;
}

/** §22: positive-integer expectation field (rounds_at_least/at_most). */
function parsePositiveInt(value: unknown, where: string, errors: string[]): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    errors.push(`${where}: must be a positive integer`);
    return undefined;
  }
  return value;
}

/** §22: ledger_contains pins — [{op_type, status}] with non-empty strings. */
function ledgerPins(
  value: unknown,
  where: string,
  errors: string[],
): readonly LedgerContainsPin[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`${where}: must be a non-empty array of {op_type, status}`);
    return undefined;
  }
  const pins: LedgerContainsPin[] = [];
  for (const [index, rawPin] of value.entries()) {
    const pinWhere = `${where}[${index}]`;
    if (!isObject(rawPin)) {
      errors.push(`${pinWhere}: must be an object`);
      continue;
    }
    const opType = rawPin["op_type"];
    const status = rawPin["status"];
    if (!isNonEmptyString(opType) || !isNonEmptyString(status)) {
      errors.push(`${pinWhere}: op_type and status must be non-empty strings`);
      continue;
    }
    pins.push({ opType, status });
  }
  return pins.length === value.length ? pins : undefined;
}

/** C11 marker pin: same expect_one/expect_zero discipline as db pins. */
function parseAuditMarkerPin(value: unknown, where: string, errors: string[]): AuditMarkerPin | undefined {
  if (!isObject(value)) {
    errors.push(`${where}: must be an object`);
    return undefined;
  }
  const marker = value["marker"];
  if (!isNonEmptyString(marker)) {
    errors.push(`${where}.marker: must be a non-empty string`);
    return undefined;
  }
  const expectOne = value["expect_one"] === true;
  const expectZero = value["expect_zero"] === true;
  if (expectOne === expectZero) {
    errors.push(`${where}: exactly one of expect_one / expect_zero must be true`);
    return undefined;
  }
  return { marker, expectOne, expectZero };
}

function markerPins(
  value: unknown,
  where: string,
  errors: string[],
): readonly AuditMarkerPin[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`${where}: must be a non-empty array of {marker, expect_one | expect_zero}`);
    return undefined;
  }
  const pins: AuditMarkerPin[] = [];
  for (const [index, rawPin] of value.entries()) {
    const pin = parseAuditMarkerPin(rawPin, `${where}[${index}]`, errors);
    if (pin !== undefined) pins.push(pin);
  }
  return pins.length === value.length ? pins : undefined;
}

function parseSeed(value: unknown, where: string, errors: string[]): ScenarioSeed | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) {
    errors.push(`${where}: must be an object`);
    return undefined;
  }
  let calibrationItem: SeedCalibrationItem | undefined;
  const rawCalibration = value["calibrationItem"];
  if (rawCalibration !== undefined) {
    if (!isObject(rawCalibration)) {
      errors.push(`${where}.calibrationItem: must be an object`);
      return undefined;
    }
    const promptSentAt = parseIsoString(
      rawCalibration["prompt_sent_at"],
      `${where}.calibrationItem.prompt_sent_at`,
      errors,
    );
    if (promptSentAt === undefined) return undefined;
    calibrationItem = { promptSentAt };
  }
  let gmailMessages: readonly SeedGmailMessage[] | undefined;
  const rawMessages = value["gmailMessages"];
  if (rawMessages !== undefined) {
    if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
      errors.push(`${where}.gmailMessages: must be a non-empty array of {from, subject, body, age_hours}`);
      return undefined;
    }
    const messages: SeedGmailMessage[] = [];
    for (const [index, rawMessage] of rawMessages.entries()) {
      const messageWhere = `${where}.gmailMessages[${index}]`;
      if (!isObject(rawMessage)) {
        errors.push(`${messageWhere}: must be an object`);
        continue;
      }
      const from = rawMessage["from"];
      const subject = rawMessage["subject"];
      const body = rawMessage["body"];
      const ageHours = rawMessage["age_hours"];
      if (
        !isNonEmptyString(from) ||
        !isNonEmptyString(subject) ||
        !isNonEmptyString(body) ||
        typeof ageHours !== "number" || !Number.isFinite(ageHours) || ageHours <= 0 || ageHours > 168
      ) {
        errors.push(
          `${messageWhere}: from/subject/body must be non-empty strings and age_hours a number in (0, 168] (7-day retention)`,
        );
        continue;
      }
      messages.push({ from, subject, body, ageHours });
    }
    if (messages.length !== rawMessages.length) return undefined;
    gmailMessages = messages;
  }
  let pendingProposal: SeedPendingProposal | undefined;
  const rawPending = value["pendingProposal"];
  if (rawPending !== undefined) {
    if (!isObject(rawPending)) {
      errors.push(`${where}.pendingProposal: must be an object`);
      return undefined;
    }
    const pType = rawPending["type"];
    const pId = rawPending["id"];
    const pPayload = rawPending["payload"];
    const pOffered = rawPending["offered"];
    if (
      !isNonEmptyString(pType) ||
      !isNonEmptyString(pId) ||
      pPayload === undefined ||
      (pOffered !== undefined && !isNonEmptyString(pOffered))
    ) {
      errors.push(
        `${where}.pendingProposal: type/id must be non-empty strings, payload required, offered optional string`,
      );
      return undefined;
    }
    pendingProposal = {
      type: pType,
      id: pId,
      payload: pPayload,
      ...(pOffered !== undefined ? { offered: pOffered } : {}),
    };
  }
  if (
    calibrationItem === undefined &&
    gmailMessages === undefined &&
    pendingProposal === undefined
  ) {
    errors.push(`${where}: at least one seed entry is required`);
    return undefined;
  }
  return { calibrationItem, gmailMessages, pendingProposal };
}

/** §22.15(b) parser: readOverrides — non-empty array of {tool, result};
 * result is any YAML value (typically a mapping — the RESULT OBJECT the
 * read executor returns verbatim). Only meaningful on path: "single". */
function parseReadOverrides(
  value: unknown,
  where: string,
  errors: string[],
): readonly ReadOverride[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`${where}: must be a non-empty array of {tool, result}`);
    return undefined;
  }
  const overrides: ReadOverride[] = [];
  for (const [index, rawOverride] of value.entries()) {
    const overrideWhere = `${where}[${index}]`;
    if (!isObject(rawOverride)) {
      errors.push(`${overrideWhere}: must be an object`);
      continue;
    }
    const tool = rawOverride["tool"];
    if (!isNonEmptyString(tool)) {
      errors.push(`${overrideWhere}.tool: must be a non-empty string`);
      continue;
    }
    if (!("result" in rawOverride)) {
      errors.push(`${overrideWhere}.result: is required (the RESULT OBJECT supplied at the tool boundary)`);
      continue;
    }
    overrides.push({ tool, result: rawOverride["result"] });
  }
  return overrides.length === value.length ? overrides : undefined;
}

function parseExpectations(value: unknown, where: string, errors: string[]): ScenarioExpectations | undefined {
  if (!isObject(value)) {
    errors.push(`${where}: must be an object`);
    return undefined;
  }
  const routedTools = stringArray(value["routed_tools"], `${where}.routed_tools`, errors);
  const routedNone = value["routed_none"];
  if (routedNone !== undefined && typeof routedNone !== "boolean") {
    errors.push(`${where}.routed_none: must be a boolean`);
    return undefined;
  }
  if (routedTools !== undefined && routedNone === true) {
    errors.push(`${where}: routed_tools and routed_none are mutually exclusive`);
    return undefined;
  }
  const replyContains = stringArray(value["reply_contains"], `${where}.reply_contains`, errors);
  const replyNotContains = stringArray(value["reply_not_contains"], `${where}.reply_not_contains`, errors);
  const noPersistenceClaimWithoutWrite = value["no_persistence_claim_without_write"];
  if (noPersistenceClaimWithoutWrite !== undefined && typeof noPersistenceClaimWithoutWrite !== "boolean") {
    errors.push(`${where}.no_persistence_claim_without_write: must be a boolean`);
    return undefined;
  }
  const interpretAudits = value["interpret_audits"];
  if (
    interpretAudits !== undefined &&
    (typeof interpretAudits !== "number" || !Number.isInteger(interpretAudits) || interpretAudits < 1)
  ) {
    errors.push(`${where}.interpret_audits: must be a positive integer`);
    return undefined;
  }
  const everyTurnNotContains = stringArray(
    value["every_turn_not_contains"],
    `${where}.every_turn_not_contains`,
    errors,
  );
  const auditMarkers = markerPins(value["audit_markers"], `${where}.audit_markers`, errors);
  if (value["audit_markers"] !== undefined && auditMarkers === undefined) return undefined;
  const answerPromptContains = stringArray(
    value["answer_prompt_contains"],
    `${where}.answer_prompt_contains`,
    errors,
  );
  const answerPromptNotContains = stringArray(
    value["answer_prompt_not_contains"],
    `${where}.answer_prompt_not_contains`,
    errors,
  );
  const ledgerContains = ledgerPins(value["ledger_contains"], `${where}.ledger_contains`, errors);
  if (value["ledger_contains"] !== undefined && ledgerContains === undefined) return undefined;
  const roundsAtLeast = parsePositiveInt(
    value["rounds_at_least"],
    `${where}.rounds_at_least`,
    errors,
  );
  const roundsAtMost = parsePositiveInt(
    value["rounds_at_most"],
    `${where}.rounds_at_most`,
    errors,
  );
  if (roundsAtLeast !== undefined && roundsAtMost !== undefined && roundsAtLeast > roundsAtMost) {
    errors.push(`${where}: rounds_at_least must not exceed rounds_at_most`);
    return undefined;
  }
  const rawIntent = value["intent_is"];
  if (rawIntent !== undefined && !isNonEmptyString(rawIntent)) {
    errors.push(`${where}.intent_is: must be a non-empty string (a §22.2 intent enum member)`);
    return undefined;
  }
  const intentIs = rawIntent as string | undefined;
  const rawPins = value["db_pins"];
  let dbPins: readonly DbPin[] | undefined;
  if (rawPins !== undefined) {
    if (!Array.isArray(rawPins) || rawPins.length === 0) {
      errors.push(`${where}.db_pins: must be a non-empty array of {sql, expect_one | expect_zero}`);
      return undefined;
    }
    const pins: DbPin[] = [];
    for (const [index, rawPin] of rawPins.entries()) {
      const pin = parseDbPin(rawPin, `${where}.db_pins[${index}]`, errors);
      if (pin !== undefined) pins.push(pin);
    }
    if (pins.length !== rawPins.length) return undefined;
    dbPins = pins;
  }
  if (
    routedTools === undefined &&
    routedNone === undefined &&
    replyContains === undefined &&
    replyNotContains === undefined &&
    dbPins === undefined &&
    noPersistenceClaimWithoutWrite === undefined &&
    interpretAudits === undefined &&
    everyTurnNotContains === undefined &&
    auditMarkers === undefined &&
    answerPromptContains === undefined &&
    answerPromptNotContains === undefined &&
    ledgerContains === undefined &&
    roundsAtLeast === undefined &&
    roundsAtMost === undefined &&
    intentIs === undefined
  ) {
    errors.push(`${where}: at least one expectation is required`);
    return undefined;
  }
  return {
    routedTools,
    routedNone,
    replyContains,
    replyNotContains,
    dbPins,
    noPersistenceClaimWithoutWrite,
    interpretAudits,
    everyTurnNotContains,
    auditMarkers,
    answerPromptContains,
    answerPromptNotContains,
    ledgerContains,
    roundsAtLeast,
    roundsAtMost,
    intentIs,
  };
}

function parseScenario(value: unknown, where: string, errors: string[]): Scenario | undefined {
  if (!isObject(value)) {
    errors.push(`${where}: must be an object`);
    return undefined;
  }
  const id = value["id"];
  if (!isNonEmptyString(id)) {
    errors.push(`${where}.id: must be a non-empty string`);
    return undefined;
  }
  const description = value["description"];
  if (!isNonEmptyString(description)) {
    errors.push(`${where}.description: must be a non-empty string`);
    return undefined;
  }
  const principal = value["principal"];
  if (!isNonEmptyString(principal)) {
    errors.push(`${where}.principal: must be a non-empty string`);
    return undefined;
  }
  const requires = stringArray(value["requires"], `${where}.requires`, errors) ?? [];
  const rawPath = value["path"];
  if (rawPath !== undefined && rawPath !== "legacy" && rawPath !== "single") {
    errors.push(`${where}.path: must be "legacy" or "single"`);
    return undefined;
  }
  const path = (rawPath ?? "legacy") as ScenarioPath;
  const rawReadOverrides = value["readOverrides"];
  if (rawReadOverrides !== undefined && path !== "single") {
    errors.push(`${where}.readOverrides: requires path: "single" (the legacy path's reads are DB-backed inside the pipeline and cannot be overridden)`);
    return undefined;
  }
  const readOverrides =
    rawReadOverrides === undefined
      ? undefined
      : parseReadOverrides(rawReadOverrides, `${where}.readOverrides`, errors);
  if (rawReadOverrides !== undefined && readOverrides === undefined) return undefined;
  const clock =
    value["clock"] === undefined ? undefined : parseIsoString(value["clock"], `${where}.clock`, errors);
  const seed = parseSeed(value["seed"], `${where}.seed`, errors);
  const turns = parseTurns(value["turns"], `${where}.turns`, errors, path);
  const expectations = parseExpectations(value["expectations"], `${where}.expectations`, errors);
  if (turns === undefined || expectations === undefined) return undefined;
  return { id, description, principal, requires, path, readOverrides, clock, seed, turns, expectations };
}

export function parseScenarioFile(raw: unknown): ScenarioFile {
  const errors: string[] = [];
  if (!isObject(raw)) {
    throw new ScenarioFormatError("scenarios: document must be a mapping");
  }
  if (raw["version"] !== 1) {
    throw new ScenarioFormatError("scenarios: version must be 1");
  }
  const rawScenarios = raw["scenarios"];
  if (!Array.isArray(rawScenarios) || rawScenarios.length === 0) {
    throw new ScenarioFormatError("scenarios: must be a non-empty array");
  }
  const scenarios: Scenario[] = [];
  const ids = new Set<string>();
  for (const [index, rawScenario] of rawScenarios.entries()) {
    const scenario = parseScenario(rawScenario, `scenarios[${index}]`, errors);
    if (scenario === undefined) continue;
    if (ids.has(scenario.id)) {
      errors.push(`scenarios[${index}].id: duplicate id "${scenario.id}"`);
      continue;
    }
    ids.add(scenario.id);
    scenarios.push(scenario);
  }
  if (errors.length > 0) {
    throw new ScenarioFormatError(`scenarios: ${errors.join("; ")}`);
  }
  return { version: 1, scenarios };
}

export function loadScenarioFile(file: string): ScenarioFile {
  return parseScenarioFile(parse(readFileSync(file, "utf8")));
}
