#!/usr/bin/env node
import { runCli } from "./commands.js";
import { readJosctlCredential } from "./keychain.js";

const baseUrl = process.env.JEHAD_API_URL ?? "http://127.0.0.1:3000";

process.exitCode = await runCli(process.argv, {
  fetchImpl: fetch,
  readCredential: readJosctlCredential,
  baseUrl,
});
