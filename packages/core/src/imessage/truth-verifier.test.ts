// §22.9 truth verifier: pure builders/parsers — the ledger-based replacement
// for claim-audit prose policing (intelligence-reset build item 3, G10's
// rejected-ledger leg). Hermetic by construction: no provider, no DB.

import { describe, expect, it } from "vitest";
import {
  buildRegenerationPrompt,
  buildVerificationPrompt,
  parseVerificationVerdict,
  type LedgerEntry,
} from "./truth-verifier.js";

const REJECTED_REMINDER: LedgerEntry = {
  kind: "operation",
  opType: "reminder_create",
  status: "rejected",
  detail: "rejected as over-budget on the forced-final round",
};

const TEN_ENTRY_LEDGER: readonly LedgerEntry[] = Array.from({ length: 10 }, (_, i) => ({
  kind: "operation",
  opType: `op_${i}`,
  status: "applied",
  id: `op_${i}:ab0${i}`,
}));

describe("parseVerificationVerdict (strict, fail-closed)", () => {
  it("parses consistent", () => {
    expect(parseVerificationVerdict('{"verdict":"consistent"}')).toEqual({ verdict: "consistent" });
  });

  it("tolerates surrounding whitespace only", () => {
    expect(parseVerificationVerdict('  \n{"verdict":"consistent"} \n')).toEqual({
      verdict: "consistent",
    });
  });

  it("parses contradicts with a finding", () => {
    const finding = "Reply claims a reminder was set; the ledger shows reminder_create rejected.";
    expect(parseVerificationVerdict(`{"verdict":"contradicts","finding":"${finding}"}`)).toEqual({
      verdict: "contradicts",
      finding,
    });
  });

  it("truncates an over-long finding to the 300-char cap (bounded, never widened)", () => {
    const long = "x".repeat(512);
    const parsed = parseVerificationVerdict(`{"verdict":"contradicts","finding":"${long}"}`);
    expect(parsed?.verdict).toBe("contradicts");
    expect((parsed as { finding: string }).finding).toHaveLength(300);
  });

  it("garbage parses to null — caller contract: treat null as consistent (§22.9 fail-open)", () => {
    for (const garbage of [
      "",
      "   ",
      "Looks good to me!",
      "null",
      "42",
      "[1,2,3]",
      '{"verdict"',
      '{"verdict":"consistent"} {"verdict":"consistent"}',
    ]) {
      expect(parseVerificationVerdict(garbage)).toBeNull();
    }
  });

  it("markdown fences parse to null (prose/fences outside the JSON)", () => {
    expect(parseVerificationVerdict('```json\n{"verdict":"consistent"}\n```')).toBeNull();
    expect(
      parseVerificationVerdict('```\n{"verdict":"contradicts","finding":"f"}\n```'),
    ).toBeNull();
  });

  it("prose before or after the JSON parses to null", () => {
    expect(parseVerificationVerdict('Verdict: {"verdict":"consistent"}')).toBeNull();
    expect(parseVerificationVerdict('{"verdict":"consistent"} — looks fine')).toBeNull();
  });

  it("extra keys parse to null (both verdicts)", () => {
    expect(parseVerificationVerdict('{"verdict":"consistent","confidence":0.9}')).toBeNull();
    expect(
      parseVerificationVerdict('{"verdict":"contradicts","finding":"f","severity":"high"}'),
    ).toBeNull();
  });

  it("malformed contradicts (missing/empty/non-string finding, unknown verdict) parses to null", () => {
    expect(parseVerificationVerdict('{"verdict":"contradicts"}')).toBeNull();
    expect(parseVerificationVerdict('{"verdict":"contradicts","finding":""}')).toBeNull();
    expect(parseVerificationVerdict('{"verdict":"contradicts","finding":"   "}')).toBeNull();
    expect(parseVerificationVerdict('{"verdict":"contradicts","finding":7}')).toBeNull();
    expect(parseVerificationVerdict('{"verdict":"maybe","finding":"f"}')).toBeNull();
    expect(parseVerificationVerdict('{"finding":"f"}')).toBeNull();
  });
});

describe("buildVerificationPrompt (bounded, action claims only)", () => {
  it("renders the owner's example: rejected reminder_create + the claiming reply (correction 3)", () => {
    const prompt = buildVerificationPrompt("Done, I set the reminder", [REJECTED_REMINDER]);
    expect(prompt).toContain("Done, I set the reminder");
    expect(prompt).toContain('"opType":"reminder_create"');
    expect(prompt).toContain('"status":"rejected"');
    expect(prompt).toContain("rejected as over-budget");
  });

  it("asks for exactly one line of JSON — both verdict literals, nothing outside", () => {
    const prompt = buildVerificationPrompt("Done.", TEN_ENTRY_LEDGER);
    expect(prompt).toContain("EXACTLY one line of JSON");
    expect(prompt).toContain('{"verdict":"consistent"}');
    expect(prompt).toContain('{"verdict":"contradicts","finding":');
  });

  it("scopes the check to ACTION claims only — no style/vocabulary/opinion policing", () => {
    const prompt = buildVerificationPrompt("Done.", TEN_ENTRY_LEDGER);
    expect(prompt).toContain("Judge ACTION claims only");
    expect(prompt).toContain("Do not judge style, vocabulary, tone, opinions");
    expect(prompt).toContain("INCLUDING failed and rejected attempts");
  });

  it("renders a 10-entry ledger in full, bounded", () => {
    const prompt = buildVerificationPrompt("Done.", TEN_ENTRY_LEDGER);
    for (let i = 0; i < 10; i++) {
      expect(prompt).toContain(`"opType":"op_${i}"`);
    }
    expect(prompt).not.toContain("omitted");
  });

  it("clips pathological ledger fields and truncates oversized ledgers to 16 entries", () => {
    const ledger: LedgerEntry[] = Array.from({ length: 30 }, (_, i) => ({
      kind: "operation",
      opType: `op_${i}`,
      status: "failed",
      detail: "D".repeat(240) + "DETAIL_TAIL_MARKER",
      summaryForVerifier: "S".repeat(240) + "SUMMARY_TAIL_MARKER",
    }));
    const prompt = buildVerificationPrompt("Done.", ledger);
    expect(prompt).toContain("14 earlier entries omitted");
    expect(prompt).toContain('"opType":"op_29"');
    expect(prompt).not.toContain('"opType":"op_0"');
    expect(prompt).not.toContain("DETAIL_TAIL_MARKER");
    expect(prompt).not.toContain("SUMMARY_TAIL_MARKER");
    expect(prompt.length).toBeLessThan(20_000);
  });

  it("renders a 1500-char (envelope-cap) reply in full, clips beyond the defensive cap", () => {
    const capReply = "X".repeat(1499) + "!";
    expect(buildVerificationPrompt(capReply, TEN_ENTRY_LEDGER)).toContain(capReply);

    const oversized = "A".repeat(2_000) + "B".repeat(3_000);
    const prompt = buildVerificationPrompt(oversized, TEN_ENTRY_LEDGER);
    expect(prompt).toContain("A".repeat(100));
    expect(prompt).not.toContain("B");
  });

  it("renders an empty ledger as []", () => {
    expect(buildVerificationPrompt("Hi", [])).toContain("<execution_ledger>\n[]");
  });
});

describe("buildRegenerationPrompt (one-shot, finding as fact, no mechanics leakage)", () => {
  it("states the finding as fact with the ledger and the draft", () => {
    const prompt = buildRegenerationPrompt(
      "User asked to be reminded to call the tailor; forced-final round.",
      [REJECTED_REMINDER],
      "The reply claims the reminder was set; the ledger shows reminder_create rejected as over-budget.",
      "Done, I set the reminder",
    );
    expect(prompt).toContain(
      "The finding is an established fact from the execution ledger",
    );
    expect(prompt).toContain(
      "The reply claims the reminder was set; the ledger shows reminder_create rejected as over-budget.",
    );
    expect(prompt).toContain('"opType":"reminder_create"');
    expect(prompt).toContain('"status":"rejected"');
    expect(prompt).toContain("Done, I set the reminder");
  });

  it("demands truthful outcomes for failed/rejected and forbids mentioning verification mechanics", () => {
    const prompt = buildRegenerationPrompt("ctx", [REJECTED_REMINDER], "f", "draft");
    expect(prompt).toContain("failed/rejected = did NOT happen");
    expect(prompt).toContain("never mention verification, findings, drafts, ledgers");
  });

  it("bounds its inputs: finding ≤300, context and draft clipped", () => {
    const prompt = buildRegenerationPrompt(
      "C".repeat(5_000) + "CTX_TAIL",
      TEN_ENTRY_LEDGER,
      "f".repeat(500),
      "D".repeat(5_000) + "DRAFT_TAIL",
    );
    expect(prompt).not.toContain("CTX_TAIL");
    expect(prompt).not.toContain("DRAFT_TAIL");
    const rendered = prompt.split("<contradiction_finding>")[1]!.split("</contradiction_finding>")[0]!;
    expect(rendered.trim()).toHaveLength(300);
    expect(prompt.length).toBeLessThan(20_000);
  });
});
