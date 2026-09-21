// Calibration workflow tests (lane C2): definition shapes, local-hour /
// weekday window guards (DST-safe), idempotent-skip on an already-open
// item, the disabled-policy clean no-op, the weekly null-content skip,
// tick logging (JSON keys only — prompt content NEVER logged), and an
// integration pass over the real notifications/principals tables.
//
// Hermetic suites run anywhere: lane C1's calibration domain
// (openDailyCalibration / runWeeklyCalibrationRollup) and the
// notification enqueue are faked at the lane contract seam
// (vi.mock over the parallel-lane modules; see calibration-contract.d.ts)
// against an in-memory executor. The integration suite needs PostgreSQL
// 16 and is skipped unless TEST_DATABASE_URL is set (per-file isolated
// db, like packages/db); there the REAL createNotification runs while
// the C1 seam stays faked (item-table assertions land with C1's merge).

import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { migrateUp, seedDomains } from "@jehad/db";
import { createIsolatedTestDb, dropIsolatedTestDb, type IsolatedDb } from "../tests/isolated-db.js";

const mocks = vi.hoisted(() => ({
  openCalibrationItem: vi.fn(),
  collectCalibrationSummary: vi.fn(),
  weeklyRollup: vi.fn(),
  createNotification: vi.fn(),
}));

vi.mock("@jehad/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@jehad/core")>();
  return {
    ...actual,
    openCalibrationItem: mocks.openCalibrationItem,
    collectCalibrationSummary: mocks.collectCalibrationSummary,
    weeklyRollup: mocks.weeklyRollup,
    createNotification: mocks.createNotification,
  };
});

import {
  calibrationPromptWorkflow,
  calibrationWeeklyWorkflow,
  calibrationWorkflows,
  CALIBRATION_WEEKLY_LOCAL_HOUR,
  CALIBRATION_WEEKLY_LOCAL_WEEKDAY,
  calibrationPolicyOf,
  DEFAULT_CALIBRATION_POLICY,
  isLocalWeekdayHour,
  loadCalibrationPolicy,
  runDailyCalibrationTick,
  runWeeklyCalibrationTick,
  type CalibrationPolicy,
} from "./calibration-workflows.js";
import { createWorkflowWorkerServer } from "./index.js";
import { assertWorkflowToken } from "./names.js";

const FIVE_FIELD_CRON_RE = /^(\S+ ){4}\S+$/;

const NOW = new Date("2026-09-17T03:30:00.000Z"); // 20:30 PDT Thu — inside the daily window
const ENABLED: CalibrationPolicy = {
  enabled: true,
  principals: ["josctl"],
  promptLocalHour: 20,
};

/** Executor-neutral context that records step ids and RUNS the step body. */
function fakeContext(onStep?: (id: string) => void) {
  return {
    input: undefined,
    runId: "test-run",
    workflow: "calibration-daily",
    step: {
      run: async (id: string, fn: () => Promise<unknown> | unknown) => {
        onStep?.(id);
        return fn();
      },
      sleep: async () => undefined,
    },
    waitForSignal: async () => null,
    pauseForApproval: async () => ({ approved: false }),
  } as const;
}

const logSpies: ReturnType<typeof vi.spyOn>[] = [];

function captureLogs(): string[] {
  const logs: string[] = [];
  logSpies.push(
    vi.spyOn(console, "log").mockImplementation((line: string) => {
      logs.push(line);
    }),
  );
  return logs;
}

/** Parsed tick-log lines (asserting on JSON KEYS, never content). */
function parsedLogs(logs: string[]): Record<string, unknown>[] {
  return logs.map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** In-memory executor for the workflow's own SQL (principal/domain lookups). */
function fakeDb(opts: { principalIds?: Record<string, string> } = {}) {
  const principalIds = opts.principalIds ?? { josctl: "00000000-0000-4000-8000-000000000001" };
  return {
    async query(text: string, values?: readonly unknown[]) {
      if (text.includes("INSERT INTO principals")) {
        return { rows: [{ id: "00000000-0000-4000-8000-0000000000ff" }] };
      }
      if (text.includes("FROM principals")) {
        const name = String(values?.[0]);
        return { rows: principalIds[name] === undefined ? [] : [{ id: principalIds[name] }] };
      }
      if (text.includes("FROM domains")) {
        return { rows: [{ id: "10000000-0000-4000-8000-000000000001" }] };
      }
      return { rows: [] };
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  mocks.openCalibrationItem.mockReset();
  mocks.collectCalibrationSummary.mockReset();
  mocks.weeklyRollup.mockReset();
  mocks.collectCalibrationSummary.mockResolvedValue({ day: "2026-09-21", entries: [] });
  mocks.createNotification.mockReset();
  delete process.env.POLICY_YAML_PATH;
});

// ------------------------------------------------------------ definitions

describe("calibration workflow registration (smoke)", () => {
  it("exports the daily + weekly definitions with valid shapes", () => {
    expect(calibrationWorkflows).toHaveLength(2);
    for (const def of calibrationWorkflows) {
      expect(def.kind).toBe("cron");
      expect(() => assertWorkflowToken("workflow name", def.name)).not.toThrow();
      expect(def.cron).toMatch(FIVE_FIELD_CRON_RE);
      expect(typeof def.fn).toBe("function");
    }
    expect(calibrationWorkflows).toContain(calibrationPromptWorkflow);
    expect(calibrationWorkflows).toContain(calibrationWeeklyWorkflow);
  });

  it("pins the names, crons, and window constants", () => {
    expect(calibrationPromptWorkflow).toMatchObject({ name: "calibration-daily", cron: "30 * * * *" });
    expect(calibrationWeeklyWorkflow).toMatchObject({ name: "calibration-weekly", cron: "0 * * * *" });
    expect(DEFAULT_CALIBRATION_POLICY).toEqual({
      enabled: false,
      principals: [],
      promptLocalHour: 20,
    });
    expect(CALIBRATION_WEEKLY_LOCAL_HOUR).toBe(20);
    expect(CALIBRATION_WEEKLY_LOCAL_WEEKDAY).toBe(0);
  });

  it("serves through the worker server (compiles to executor functions)", () => {
    const server = createWorkflowWorkerServer({ workflows: [...calibrationWorkflows] });
    expect(typeof server.listen).toBe("function");
    server.close();
  });

  it("isLocalWeekdayHour matches only its PT weekday-hour (DST-safe)", () => {
    // PDT (UTC-7): Sunday 20:00 PT === Monday 03:00 UTC (day boundary)
    expect(isLocalWeekdayHour(new Date("2026-09-21T03:00:00.000Z"), 20, 0)).toBe(true);
    // Monday 20:00 PT — right hour, wrong weekday
    expect(isLocalWeekdayHour(new Date("2026-09-22T03:00:00.000Z"), 20, 0)).toBe(false);
    // Sunday 21:00 PT — right weekday, wrong hour
    expect(isLocalWeekdayHour(new Date("2026-09-21T04:00:00.000Z"), 20, 0)).toBe(false);
    // PST (UTC-8): Sunday 20:00 PT === Monday 04:00 UTC
    expect(isLocalWeekdayHour(new Date("2027-01-18T04:00:00.000Z"), 20, 0)).toBe(true);
  });
});

/** Executor-neutral context whose EVERY step throws (window-guard tests). */
function blockedContext() {
  return {
    input: undefined,
    runId: "test-run",
    workflow: "calibration-weekly",
    step: {
      run: async (): Promise<never> => {
        throw new Error("step must not run outside the window");
      },
      sleep: async () => undefined,
    },
    waitForSignal: async () => null,
    pauseForApproval: async () => ({ approved: false }),
  } as const;
}

// --------------------------------------------------------- window guards

describe("window guards (hourly no-op outside the window)", () => {
  it("daily no-ops outside the policy hour (no step, no core calls)", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-17T04:30:00.000Z")); // 21:30 PDT — outside
      const result = await calibrationPromptWorkflow.fn(blockedContext());
      expect(result).toEqual({ skippedWindow: true });
      expect(mocks.openCalibrationItem).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("weekly no-ops outside Sunday-20:00 local (no step, no core calls)", async () => {
    vi.useFakeTimers();
    try {
      // Sunday 21:00 PDT — inside the day, outside the hour
      vi.setSystemTime(new Date("2026-09-21T04:00:00.000Z"));
      expect(await calibrationWeeklyWorkflow.fn(blockedContext())).toEqual({
        skippedWindow: true,
      });
      // Monday 20:00 PDT — inside the hour, outside the weekday
      vi.setSystemTime(new Date("2026-09-22T03:00:00.000Z"));
      expect(await calibrationWeeklyWorkflow.fn(blockedContext())).toEqual({
        skippedWindow: true,
      });
      // Saturday 21:00 PDT — outside both
      vi.setSystemTime(new Date("2026-09-20T04:00:00.000Z"));
      expect(await calibrationWeeklyWorkflow.fn(blockedContext())).toEqual({
        skippedWindow: true,
      });
      expect(mocks.weeklyRollup).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("daily runs its tick step inside the window (disabled default → clean no-op log)", async () => {
    vi.useFakeTimers();
    const prevPath = process.env.POLICY_YAML_PATH;
    process.env.POLICY_YAML_PATH = new URL(
      "./calibration-workflows.test.fixture.yaml",
      import.meta.url,
    ).pathname;
    const logs = captureLogs();
    try {
      vi.setSystemTime(NOW); // 20:30 PDT — inside
      // Fixture policy with no calibration section → fail-safe disabled
      // default applies end-to-end (the live repo policy is ratified ON).
      const steps: string[] = [];
      const result = await calibrationPromptWorkflow.fn(fakeContext((id) => steps.push(id)));
      expect(steps).toEqual(["calibration-daily-tick"]);
      expect(result).toEqual({ status: "disabled" });
      expect(logs).toEqual([JSON.stringify({ workflow: "calibration-daily", status: "disabled" })]);
      expect(mocks.openCalibrationItem).not.toHaveBeenCalled();
      expect(mocks.createNotification).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      if (prevPath === undefined) delete process.env.POLICY_YAML_PATH;
      else process.env.POLICY_YAML_PATH = prevPath;
    }
  });
});

// ------------------------------------------------------------- policy

describe("calibration policy (loader + accessor)", () => {
  it("loadCalibrationPolicy reads the module-relative repo policy (owner-ratified section)", async () => {
    // No POLICY_YAML_PATH: exercises the module-relative default (three
    // ups from packages/workflow/src = repo root).
    const policy = await loadCalibrationPolicy();
    expect(policy).toEqual({ enabled: true, principals: ["josctl"], promptLocalHour: 20 });
  });

  it("loadCalibrationPolicy honors POLICY_YAML_PATH (parsable, no section → disabled)", async () => {
    process.env.POLICY_YAML_PATH = new URL("./calibration-workflows.test.fixture.yaml", import.meta.url)
      .pathname;
    expect(await loadCalibrationPolicy()).toEqual(DEFAULT_CALIBRATION_POLICY);
  });

  it("calibrationPolicyOf maps the section and fails safe on junk", () => {
    expect(calibrationPolicyOf({ calibration: { enabled: true, principals: ["a", "b"], prompt_local_hour: 19 } }))
      .toEqual({ enabled: true, principals: ["a", "b"], promptLocalHour: 19 });
    expect(calibrationPolicyOf({ calibration: { enabled: true, principals: ["x"], promptLocalHour: 21 } }).promptLocalHour)
      .toBe(21);
    // absent / non-object / disabled / junk hour / junk principals
    expect(calibrationPolicyOf(undefined)).toEqual(DEFAULT_CALIBRATION_POLICY);
    expect(calibrationPolicyOf({})).toEqual(DEFAULT_CALIBRATION_POLICY);
    expect(calibrationPolicyOf({ calibration: "nope" })).toEqual(DEFAULT_CALIBRATION_POLICY);
    expect(calibrationPolicyOf({ calibration: { enabled: false, principals: ["x"] } }).enabled).toBe(false);
    expect(calibrationPolicyOf({ calibration: { enabled: true, principals: ["x"], promptLocalHour: 24 } }).promptLocalHour)
      .toBe(20);
    expect(calibrationPolicyOf({ calibration: { enabled: true, principals: ["ok", 7, ""] } }).principals)
      .toEqual(["ok"]);
  });
});

// ----------------------------------------------------------- daily tick

describe("runDailyCalibrationTick (hermetic: C1 seam faked)", () => {
  it("opens the item and enqueues the prompt; tick log keys are workflow/principal/created only", async () => {
    const prompt = "SECRET-PROMPT-CONTENT";
    mocks.openCalibrationItem.mockResolvedValue({
      item: { id: "00000000-0000-4000-8000-0000000000aa" },
      created: true,
      prompt,
    });
    mocks.createNotification.mockResolvedValue({ id: "notif-1" });
    const logs = captureLogs();

    const result = await runDailyCalibrationTick(fakeDb(), { policy: ENABLED, now: NOW });

    expect(mocks.openCalibrationItem).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        principalId: "00000000-0000-4000-8000-000000000001",
        surface: "imessage",
      }),
      { notify: true },
    );
    // notify=true → core enqueues the calibration notification itself.
    expect(mocks.createNotification).toHaveBeenCalledTimes(0);
    // Content NEVER logged: assert on JSON keys only.
    expect(parsedLogs(logs)).toEqual([
      { workflow: "calibration-daily", principal: "josctl", created: true },
    ]);
    expect(logs.join("")).not.toContain(prompt);
    expect(result).toEqual({
      outcomes: [{ principal: "josctl", created: true, sent: true }],
    });
  });

  it("skips the send when the item already exists (created=false — idempotent)", async () => {
    mocks.openCalibrationItem.mockResolvedValue({
      item: { id: "00000000-0000-4000-8000-0000000000aa" },
      created: false,
      prompt: "SECRET-PROMPT-CONTENT",
    });
    const logs = captureLogs();

    const result = await runDailyCalibrationTick(fakeDb(), { policy: ENABLED, now: NOW });

    expect(mocks.createNotification).not.toHaveBeenCalled();
    expect(parsedLogs(logs)).toEqual([
      { workflow: "calibration-daily", principal: "josctl", created: false },
    ]);
    expect(logs.join("")).not.toContain("SECRET-PROMPT-CONTENT");
    expect(result).toEqual({ outcomes: [{ principal: "josctl", created: false }] });
  });

  it("disabled policy / empty principals → clean no-op tick log", async () => {
    for (const policy of [
      { ...ENABLED, enabled: false },
      { ...ENABLED, principals: [] },
    ] as const) {
      const logs = captureLogs();
      const result = await runDailyCalibrationTick(fakeDb(), { policy, now: NOW });
      expect(result).toEqual({ status: "disabled" });
      expect(logs).toEqual([JSON.stringify({ workflow: "calibration-daily", status: "disabled" })]);
      expect(mocks.openCalibrationItem).not.toHaveBeenCalled();
      expect(mocks.createNotification).not.toHaveBeenCalled();
    }
  });

  it("unknown principal → skipped, other principals still run", async () => {
    mocks.openCalibrationItem.mockResolvedValue({
      item: { id: "00000000-0000-4000-8000-0000000000ab" },
      created: true,
      prompt: "p2",
    });
    mocks.createNotification.mockResolvedValue({ id: "notif-2" });
    const logs = captureLogs();
    const db = fakeDb({
      principalIds: { second: "00000000-0000-4000-8000-000000000002" },
    });

    const result = await runDailyCalibrationTick(db, {
      policy: { ...ENABLED, principals: ["ghost", "second"] },
      now: NOW,
    });

    expect(mocks.openCalibrationItem).toHaveBeenCalledTimes(1);
    expect(parsedLogs(logs)).toEqual([
      { workflow: "calibration-daily", principal: "ghost", skipped: "principal-not-found" },
      { workflow: "calibration-daily", principal: "second", created: true },
    ]);
    expect(result.outcomes).toEqual([
      { principal: "ghost", skipped: "principal-not-found" },
      { principal: "second", created: true, sent: true },
    ]);
  });
});

// --------------------------------------------------------- weekly tick

describe("runWeeklyCalibrationTick (hermetic: C1 seam faked)", () => {
  it("skips the send on null content (too little data) and tick-logs the shortfall", async () => {
    mocks.weeklyRollup.mockResolvedValue({ weekStart: "2026-09-14", avgRating: null, daysRated: 0, missCount: 0, missCategories: {}, feedbackCounts: {}, text: null });
    const logs = captureLogs();

    const result = await runWeeklyCalibrationTick(fakeDb(), { policy: ENABLED, now: NOW });

    expect(mocks.createNotification).not.toHaveBeenCalled();
    expect(parsedLogs(logs)).toEqual([
      {
        workflow: "calibration-weekly",
        principal: "josctl",
        daysRated: 0,
        skipped: "insufficient-data",
      },
    ]);
    expect(result).toEqual({
      outcomes: [{ principal: "josctl", daysRated: 0, skipped: "insufficient-data" }],
    });
  });

  it("enqueues the rollup when content renders; log keys carry counts only", async () => {
    mocks.weeklyRollup.mockResolvedValue({
      weekStart: "2026-09-14",
      avgRating: 3.2,
      daysRated: 6,
      missCount: 1,
      missCategories: {},
      feedbackCounts: {},
      text: "SECRET-ROLLUP-CONTENT",
    });
    mocks.createNotification.mockResolvedValue({ id: "notif-3" });
    const logs = captureLogs();

    const result = await runWeeklyCalibrationTick(fakeDb(), { policy: ENABLED, now: NOW });

    expect(mocks.weeklyRollup).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ principalId: "00000000-0000-4000-8000-000000000001" }),
    );
    const input = mocks.createNotification.mock.calls[0]![1]!;
    expect(input).toMatchObject({
      kind: "custom",
      title: "Weekly calibration rollup",
      sourceType: "run",
      sourceId: null,
    });
    expect(input.payload).toEqual({ principal: "josctl", content: "SECRET-ROLLUP-CONTENT" });
    expect(parsedLogs(logs)).toEqual([
      { workflow: "calibration-weekly", principal: "josctl", daysRated: 6, sent: true },
    ]);
    expect(logs.join("")).not.toContain("SECRET-ROLLUP-CONTENT");
    expect(result).toEqual({
      outcomes: [{ principal: "josctl", daysRated: 6, sent: true }],
    });
  });

  it("disabled policy → clean no-op tick log", async () => {
    const logs = captureLogs();
    const result = await runWeeklyCalibrationTick(fakeDb(), {
      policy: { ...ENABLED, enabled: false },
      now: NOW,
    });
    expect(result).toEqual({ status: "disabled" });
    expect(logs).toEqual([JSON.stringify({ workflow: "calibration-weekly", status: "disabled" })]);
    expect(mocks.weeklyRollup).not.toHaveBeenCalled();
  });
});

// ----------------------------------------------------------- integration

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)("calibration daily tick (integration: real notification tables)", () => {
  let db: IsolatedDb;

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "workflowcalib");
    await migrateUp(db.pool);
    await seedDomains(db.pool);
    // The REAL notification enqueue under the recording seam (the gmail
    // lane's pattern: real service, faked parallel-lane module).
    const actual = await vi.importActual<typeof import("@jehad/core")>("@jehad/core");
    mocks.createNotification.mockImplementation(actual.createNotification);
  });

  afterAll(async () => {
    await dropIsolatedTestDb(TEST_DATABASE_URL!, db);
  });

  it("full daily path: opens the item (C1 seam) and lands a real notification row", async () => {
    const itemId = "00000000-0000-4000-8000-0000000000c0";
    const principal = await db.pool.query(
      `WITH ins AS (
         INSERT INTO principals (type, name) VALUES ('user', 'josctl') ON CONFLICT (name) DO NOTHING RETURNING id
       ) SELECT id FROM ins UNION ALL SELECT id FROM principals WHERE name = 'josctl' LIMIT 1`,
    );
    const principalId = String(principal.rows[0].id);
    mocks.openCalibrationItem.mockResolvedValue({
      item: { id: itemId },
      created: true,
      prompt: "integration-prompt-content",
    });
    const logs = captureLogs();

    const result = await runDailyCalibrationTick(db.pool, { policy: ENABLED, now: NOW });

    expect(mocks.openCalibrationItem).toHaveBeenCalledWith(
      db.pool,
      expect.objectContaining({ principalId, surface: "imessage" }),
      { notify: true },
    );
    expect(parsedLogs(logs)).toEqual([
      { workflow: "calibration-daily", principal: "josctl", created: true },
    ]);

    // notify=true → the REAL openCalibrationItem enqueues the calibration
    // notification on the core side (pinned in C1's suite); this suite
    // mocks it, so we assert the tick contract: principal resolution,
    // created flags, and tick logs.
    expect(result).toEqual({ outcomes: [{ principal: "josctl", created: true, sent: true }] });
    expect(mocks.openCalibrationItem).toHaveBeenCalledWith(
      db.pool,
      expect.objectContaining({ principalId, surface: "imessage" }),
      { notify: true },
    );

    // Idempotent replay: created=false → skipped, no second open call.
    mocks.openCalibrationItem.mockClear();
    mocks.openCalibrationItem.mockResolvedValue({
      item: { id: itemId },
      created: false,
      prompt: "integration-prompt-content",
    });
    const replay = await runDailyCalibrationTick(db.pool, { policy: ENABLED, now: NOW });
    expect(replay).toEqual({ outcomes: [{ principal: "josctl", created: false }] });
  });
});
