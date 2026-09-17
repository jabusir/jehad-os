#!/usr/bin/env node
import { runCli } from "./commands.js";
import { runMetricsCommand } from "./commands/metrics.js";
import { readJosctlCredential } from "./keychain.js";

const baseUrl = process.env.JEHAD_API_URL ?? "http://127.0.0.1:3000";

if (process.argv[2] === "metrics") {
  // josctl metrics — direct DB read until a metrics API route lands (M6D).
  process.exitCode = await runMetricsCommand(process.argv, {
    databaseUrl: process.env.DATABASE_URL ?? "postgres://localhost:5432/jehad",
  });
} else {
  process.exitCode = await runCli(process.argv, {
    fetchImpl: fetch,
    readCredential: readJosctlCredential,
    baseUrl,
  });
}
