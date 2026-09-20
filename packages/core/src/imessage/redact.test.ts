// Denylist redaction unit tests (no DB) — Phase D §2.1: every secret
// class positive, the mandated negatives (phones/dates/UUIDs survive),
// idempotence (the mask matches no pattern), and unicode safety.

import { describe, expect, it } from "vitest";
import { REDACTED_TOKEN, redactContent } from "./redact.js";

const MASK = "⦙redacted⦙";

describe("redactContent — card numbers (Luhn-gated)", () => {
  it.each([
    ["my card is 4242 4242 4242 4242", `my card is ${MASK}`],
    ["4242-4242-4242-4242", MASK],
    ["try 4242.4242.4242.4242 ok", `try ${MASK} ok`],
    ["378282246310005", MASK], // 15-digit Amex
    ["30569309025904", MASK], // 14-digit Diners
    ["4222222222222", MASK], // 13-digit Visa
    ["pay 4242 4242 4242 4242.", `pay ${MASK}.`], // trailing punctuation preserved
  ])("%s is masked", (input, expected) => {
    expect(redactContent(input)).toBe(expected);
  });

  it("a 13-digit INVALID-Luhn number is NOT masked", () => {
    expect(redactContent("4242424242421")).toBe("4242424242421");
  });

  it("longer-than-card digit runs are not split into card matches", () => {
    expect(redactContent("424242424242424242424242424")).toBe("424242424242424242424242424");
  });
});

describe("redactContent — known API-token prefixes", () => {
  it.each([
    ["key sk-AbcDef1234567890123456789 now", `key ${MASK} now`],
    ["sk-ant-api03-Abcdef1234567890abcdef1234", MASK],
    ["AKIA1234ABCD5678EFGH", MASK],
    ["ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123", MASK],
    ["gho_ABCDEFGHIJKLMNOPQRSTUVWXYZ123", MASK],
    ["github_pat_11ABCDEFG0123456789abcdef", MASK],
    ["xoxb-123456789012-AbCdEfGhIjKl", MASK],
    ["AIzaSyA1234567890abcdefghijklmnopqrstuv", MASK],
  ])("%s is masked", (input, expected) => {
    expect(redactContent(input)).toBe(expected);
  });

  it("short near-miss tokens are NOT masked", () => {
    expect(redactContent("sk-short1")).toBe("sk-short1");
    expect(redactContent("AKIA123")).toBe("AKIA123");
    expect(redactContent("prefixAKIA1234ABCD5678EFGH")).toBe("prefixAKIA1234ABCD5678EFGH"); // mid-word, no boundary
  });
});

describe("redactContent — bearer tokens", () => {
  it("masks the credential, keeps the scheme word", () => {
    expect(redactContent("Authorization: Bearer AbCdEf1234567890")).toBe(
      `Authorization: Bearer ${MASK}`,
    );
  });

  it("is case-insensitive on the scheme", () => {
    expect(redactContent("bearer eyJhbGciOi.abc.12345678")).toBe(`bearer ${MASK}`);
  });

  it("short bearer credentials are NOT masked", () => {
    expect(redactContent("Bearer abcdef")).toBe("Bearer abcdef");
  });
});

describe("redactContent — long opaque runs (40+, letters AND digits)", () => {
  const mixed = "aB3".repeat(15); // 45 chars, letters + digits

  it("standalone mixed runs are masked", () => {
    expect(redactContent(`paste ${mixed} end`)).toBe(`paste ${MASK} end`);
  });

  it("pure-alpha, pure-digit, and sub-40 runs are NOT masked", () => {
    expect(redactContent("a".repeat(45))).toBe("a".repeat(45));
    expect(redactContent("7".repeat(45))).toBe("7".repeat(45));
    expect(redactContent("aB3".repeat(13))).toBe("aB3".repeat(13)); // 39 chars
  });

  it("pure lowercase hex of ANY length is a hash, NOT a secret — left unmasked (documented decision)", () => {
    expect(redactContent("0123456789abcdef".repeat(4))).toBe("0123456789abcdef".repeat(4)); // sha256
    expect(redactContent("0123456789abcdef".repeat(8))).toBe("0123456789abcdef".repeat(8)); // sha512
  });

  it("URLs are never masked", () => {
    const url = "https://example.com/very/long/path-with-2026-digits";
    expect(redactContent(`see ${url} please`)).toBe(`see ${url} please`);
  });
});

describe("redactContent — mandated negatives", () => {
  it.each([
    "+1 (562) 370-7369",
    "2026-09-20",
    "123e4567-e89b-12d3-a456-426614174000",
    "meet me at 5pm by the pier",
  ])("%s passes through verbatim", (input) => {
    expect(redactContent(input)).toBe(input);
  });
});

describe("redactContent — structural properties", () => {
  it("empty string passes through", () => {
    expect(redactContent("")).toBe("");
  });

  it("multi-line: every line's secret is masked, structure preserved", () => {
    const input = "first line\nsk-Abcdef123456789012345\nlast line 4111 1111 1111 1111 end";
    expect(redactContent(input)).toBe(
      `first line\n${MASK}\nlast line ${MASK} end`,
    );
  });

  it("unicode and emoji around a secret are untouched", () => {
    expect(redactContent("🎉 use card 4242 4242 4242 4242 🎊 naïve café")).toBe(
      `🎉 use card ${MASK} 🎊 naïve café`,
    );
  });

  it("is idempotent — the mask itself matches no pattern", () => {
    const samples = [
      "my card is 4242 4242 4242 4242",
      "Authorization: Bearer AbCdEf1234567890",
      "sk-AbcDef1234567890123456789",
      `paste ${"aB3".repeat(15)} end`,
      "bearer ⦙redacted⦙ already masked",
      "⦙redacted⦙ ⦙redacted⦙ adjacent masks",
      "no secrets here, just 2026-09-20 and +1 (562) 370-7369",
    ];
    for (const s of samples) {
      const once = redactContent(s);
      expect(redactContent(once)).toBe(once);
    }
  });

  it("REDACTED_TOKEN is the exported literal", () => {
    expect(REDACTED_TOKEN).toBe(MASK);
  });
});
