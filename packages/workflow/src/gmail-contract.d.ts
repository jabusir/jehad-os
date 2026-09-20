// TEMPORARY lane-G3 contract seam — DELETE AT INTEGRATION.
//
// Lanes G1 (packages/adapters gmail source) and G2 (packages/core syncGmail)
// build in parallel worktrees off main; until they merge, this augmentation
// declares the exports gmail-workflows.ts codes against. The orchestrator
// deletes this file once both lanes land (their real implementations replace
// these declarations) — keep the export names here in sync with G1/G2.
//
// Expected real signatures (plan §11 G1/G2):
//   - G1: token provider (GMAIL_ACCESS_TOKEN env, else the `jehad-gmail`
//     Keychain item) + the read-only Gmail SourceAdapter factory.
// - G2: syncGmail(db, adapter, opts) — cursor pipeline returning a status
//   report (gmail_sync_state health, newEvents count).

// `export {}` makes this a module file so the blocks below are module
// AUGMENTATIONS (additive) rather than shadowing ambient declarations.
export {};

declare module "@jehad/adapters" {
  export function gmailTokenProvider(): Promise<string>;
  export function createGmailSource(opts: {
    readonly tokenProvider: () => Promise<string> | string;
  }): unknown;
}

declare module "@jehad/core" {
  export function syncGmail(
    db: unknown,
    adapter: unknown,
    opts: { now(): Date; policy: unknown; actor: string },
  ): Promise<{ status: string; newEvents?: number }>;
}
