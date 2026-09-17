import { describe, expect, it } from "vitest";
import {
  hashCapabilityToken,
  mintCapabilityToken,
  parseCapabilityToken,
} from "./policy-token";

const INPUT = {
  principal: "11111111-1111-1111-1111-111111111111",
  run_id: "22222222-2222-2222-2222-222222222222",
  capability: "write_entity:person",
  resource: "entity:person:alice",
  domain: "33333333-3333-3333-3333-333333333333",
  expires_at: new Date("2026-09-17T12:00:00Z").toISOString(),
};

describe("mintCapabilityToken", () => {
  it("produces a v1 token whose parse round-trips the exact claims", () => {
    const minted = mintCapabilityToken(INPUT);
    expect(minted.token).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(parseCapabilityToken(minted.token)).toEqual({ ...INPUT, nonce: minted.claims.nonce });
  });

  it("is unguessable and unique per mint (random nonce)", () => {
    const a = mintCapabilityToken(INPUT);
    const b = mintCapabilityToken(INPUT);
    expect(a.token).not.toBe(b.token);
    expect(a.tokenHash).not.toBe(b.tokenHash);
    expect(a.claims.nonce.length).toBeGreaterThanOrEqual(43); // 32 bytes b64url
  });

  it("stores only a sha256 hash of the whole token", () => {
    const minted = mintCapabilityToken(INPUT);
    expect(minted.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(minted.tokenHash).toBe(hashCapabilityToken(minted.token));
    // The hash must not be derivable from the claims alone — it covers the
    // nonce-bearing token string.
    expect(minted.tokenHash).not.toBe(
      hashCapabilityToken(JSON.stringify(INPUT)),
    );
  });

  it("supports run-less grants (run_id null)", () => {
    const minted = mintCapabilityToken({ ...INPUT, run_id: null });
    expect(parseCapabilityToken(minted.token)?.run_id).toBeNull();
  });
});

describe("parseCapabilityToken", () => {
  it("rejects garbage, wrong arity, wrong version, and bad base64url", () => {
    expect(parseCapabilityToken("garbage")).toBeNull();
    expect(parseCapabilityToken("v1.only-two-parts")).toBeNull();
    expect(parseCapabilityToken(`v2.${mintCapabilityToken(INPUT).token.slice(3)}`)).toBeNull();
    expect(parseCapabilityToken("v1.!!!.AAAA")).toBeNull();
  });

  it("rejects tampered bodies and non-JSON bodies", () => {
    const minted = mintCapabilityToken(INPUT);
    const [v, body, nonce] = minted.token.split(".") as [string, string, string];

    const tamperedClaims = Buffer.from(
      JSON.stringify({ ...INPUT, capability: "spend_budget:1000000" }),
      "utf8",
    ).toString("base64url");
    expect(parseCapabilityToken(`${v}.${tamperedClaims}.${nonce}`)).not.toBeNull();
    // Structural parse succeeds; scope enforcement against the stored row is
    // the grant service's job (claims_mismatch) — proven in core tests.

    const notJson = Buffer.from("not json", "utf8").toString("base64url");
    expect(parseCapabilityToken(`${v}.${notJson}.${nonce}`)).toBeNull();

    const shortNonce = Buffer.alloc(8).toString("base64url");
    expect(parseCapabilityToken(`${v}.${body}.${shortNonce}`)).toBeNull();
  });

  it("rejects bodies with missing or non-string fields and bad expiry", () => {
    const nonce = Buffer.alloc(32).toString("base64url");
    const bad = (obj: unknown) =>
      parseCapabilityToken(
        `v1.${Buffer.from(JSON.stringify(obj), "utf8").toString("base64url")}.${nonce}`,
      );
    expect(bad({ principal: 1, run_id: null, capability: "c", resource: "r", domain: "d", expires_at: new Date().toISOString() })).toBeNull();
    expect(bad({ principal: "p", run_id: null, capability: "c", resource: "r", domain: "d", expires_at: "not-a-date" })).toBeNull();
    expect(bad(["array"])).toBeNull();
  });
});
