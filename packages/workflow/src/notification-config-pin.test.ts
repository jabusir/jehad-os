// F0 regression pin (plan Wave F2): every CONVERT-listed workflow
// notification producer passes the policy-loaded config to
// createNotification — the DEFAULT_NOTIFICATIONS_CONFIG fallback ("lucky
// default") must never silently return — and the do-not-convert set
// (review-governed by design) never gains one. Source-read pin,
// boundary.test.ts style; runs anywhere, no database.

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/**
 * Convert list (plan F0) — file plus the exact config-passing marker its
 * createNotification call must carry:
 *   - self-loading hooks pass `input.config ?? (await workflowNotificationsConfig())`
 *   - direct call sites pass `config: await workflowNotificationsConfig()`
 */
const CONVERT_FILES: readonly (readonly [string, string])[] = [
  [
    "packages/core/src/notifications/service.ts",
    "input.config ?? (await workflowNotificationsConfig())",
  ],
  [
    "packages/core/src/calibration/service.ts",
    "config: await workflowNotificationsConfig()",
  ],
  [
    "packages/workflow/src/calibration-workflows.ts",
    "config: await workflowNotificationsConfig()",
  ],
  [
    "packages/workflow/src/grant-workflows.ts",
    "config: await workflowNotificationsConfig()",
  ],
];

/**
 * Do-not-convert set (plan F0): kind=reply is §4-conjunction-governed
 * (conversation.ts), the lockout alert is review-governed kind=custom
 * (review-commands.ts), the pairing notice is kind=brief by owner default
 * (pairing.ts). Their governance is intentional — no policy config may
 * appear here.
 */
const DO_NOT_CONVERT_FILES = [
  "packages/core/src/imessage/conversation.ts",
  "packages/core/src/imessage/review-commands.ts",
  "packages/core/src/imessage/pairing.ts",
];

describe("F0 pin: workflow notification producers pass the policy config", () => {
  it("every convert-listed producer file carries the config-passing call", async () => {
    for (const [rel, marker] of CONVERT_FILES) {
      const content = await readFile(join(REPO_ROOT, rel), "utf8");
      expect(content.includes(marker), `${rel} must contain ${JSON.stringify(marker)}`).toBe(true);
    }
  });

  it("the do-not-convert set never loads a notification config", async () => {
    for (const rel of DO_NOT_CONVERT_FILES) {
      const content = await readFile(join(REPO_ROOT, rel), "utf8");
      // Wave T carve-out: conversation.ts hosts the kind=typing control
      // producer, which is policy-governed by design (it is NOT the reply
      // path). The REPLY producer itself must stay default-config: assert
      // the reply-kind createNotification block passes no config.
      if (rel === "packages/core/src/imessage/conversation.ts") {
        const replyBlock = content.slice(
          content.indexOf('kind: "reply"'),
          content.indexOf("sourceType", content.indexOf('kind: "reply"')),
        );
        expect(
          replyBlock.includes("config"),
          "the reply producer must stay default-config (conjunction governs it)",
        ).toBe(false);
        continue;
      }
      expect(
        content.includes("workflowNotificationsConfig") || content.includes("loadNotificationsConfig"),
        `${rel} must stay policy-config-free (do-not-convert set)`,
      ).toBe(false);
    }
  });
});
