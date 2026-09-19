/**
 * Writes the committed fixture matrix to test/decoder/fixtures/.
 *
 * Run from the repo root after changing fixtures-spec.ts:
 *   pnpm -w exec tsx apps/imessage-sensor/test/decoder/generate-fixtures.ts
 *
 * Each fixture becomes <name>.bin (the blob) + <name>.json (expected
 * DecodeResult; failure cases pin `reason` only — `detail` is diagnostic).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FIXTURES, fixtureBlob } from "./fixtures-spec.ts";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "fixtures");
mkdirSync(outDir, { recursive: true });

for (const [name, fixture] of Object.entries(FIXTURES)) {
  const blob = fixtureBlob(name);
  writeFileSync(join(outDir, `${name}.bin`), blob);
  writeFileSync(join(outDir, `${name}.json`), `${JSON.stringify(fixture.expected, null, 2)}\n`);
  console.log(`${name}.bin (${blob.length} bytes) + ${name}.json`);
}
