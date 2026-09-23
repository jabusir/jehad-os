#!/usr/bin/env node
import { runCli } from "./commands.js";
import { runBriefCommand } from "./commands/brief.js";
import { runFeedbackCommand } from "./commands/feedback.js";
import { runImessageCommand } from "./commands/imessage.js";
import { runMetricsCommand } from "./commands/metrics.js";
import { runDelegateCommand, runOpsCommand } from "./commands/ops.js";
import { readJosctlCredential } from "./keychain.js";

const baseUrl = process.env.JEHAD_API_URL ?? "http://127.0.0.1:3000";

if (process.argv[2] === "metrics") {
  // josctl metrics — direct DB read until a metrics API route lands (M6D).
  process.exitCode = await runMetricsCommand(process.argv, {
    databaseUrl: process.env.DATABASE_URL ?? "postgres://localhost:5432/jehad",
  });
} else if (process.argv[2] === "brief") {
  // josctl brief [--close] — direct DB read until a brief API route lands (M6B).
  process.exitCode = await runBriefCommand(process.argv, {
    databaseUrl: process.env.DATABASE_URL ?? "postgres://localhost:5432/jehad",
  });
} else if (process.argv[2] === "feedback") {
  // josctl feedback — direct-DB append-only taps until a feedback API route
  // lands (E3-B; same Phase-1 pattern as metrics/brief).
  process.exitCode = await runFeedbackCommand(process.argv, {
    databaseUrl: process.env.DATABASE_URL ?? "postgres://localhost:5432/jehad",
  });
} else if (process.argv[2] === "delegate") {
  // josctl delegate "<directive>" — D0 intake; dispatches the executor via
  // the WorkflowRuntime port (roadmap §19 D0).
  process.exitCode = await runDelegateCommand(process.argv, { stdout: process.stdout });
  if (process.exitCode === undefined) process.exitCode = 0;
} else if (process.argv[2] === "ops") {
  // josctl ops now|outcome|criterion|decide — CR0 (roadmap §16).
  process.exitCode = await runOpsCommand(process.argv, { stdout: process.stdout });
  if (process.exitCode === undefined) process.exitCode = 0;
} else if (process.argv[2] === "imessage") {
  // josctl imessage pair|identities — direct-DB pairing admin (Lane P; the
  // code is printed ONCE and never persisted plaintext).
  process.exitCode = await runImessageCommand(process.argv, {
    databaseUrl: process.env.DATABASE_URL ?? "postgres://localhost:5432/jehad",
  });
} else {
  process.exitCode = await runCli(process.argv, {
    fetchImpl: fetch,
    readCredential: readJosctlCredential,
    baseUrl,
  });
}
