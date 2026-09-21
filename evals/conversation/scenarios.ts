import { readFileSync } from "node:fs";
import { parse } from "yaml";

export type ScriptPass = "route" | "answer";

export interface ScriptedPass {
  readonly pass: ScriptPass;
  readonly output: string;
}

export interface ScenarioTurn {
  readonly user: string;
  readonly modelScript: readonly ScriptedPass[];
}

export interface DbPin {
  readonly sql: string;
  readonly expectOne: boolean;
  readonly expectZero: boolean;
}

export interface ScenarioExpectations {
  readonly routedTools?: readonly string[];
  readonly routedNone?: boolean;
  readonly replyContains?: readonly string[];
  readonly replyNotContains?: readonly string[];
  readonly dbPins?: readonly DbPin[];
}

export interface Scenario {
  readonly id: string;
  readonly description: string;
  readonly principal: string;
  readonly requires: readonly string[];
  readonly turns: readonly ScenarioTurn[];
  readonly expectations: ScenarioExpectations;
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

function parseTurns(value: unknown, where: string, errors: string[]): readonly ScenarioTurn[] | undefined {
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
    if (!Array.isArray(rawScript) || rawScript.length === 0) {
      errors.push(`${turnWhere}.modelScript: must be a non-empty array of {pass, output}`);
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
      if (pass !== "route" && pass !== "answer") {
        errors.push(`${passWhere}.pass: must be "route" or "answer"`);
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
    dbPins === undefined
  ) {
    errors.push(`${where}: at least one expectation is required`);
    return undefined;
  }
  return { routedTools, routedNone, replyContains, replyNotContains, dbPins };
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
  const turns = parseTurns(value["turns"], `${where}.turns`, errors);
  const expectations = parseExpectations(value["expectations"], `${where}.expectations`, errors);
  if (turns === undefined || expectations === undefined) return undefined;
  return { id, description, principal, requires, turns, expectations };
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
