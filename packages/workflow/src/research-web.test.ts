// Pure unit tests for the research web reconciliation helpers
// (mission-execution v1): URL normalization for mechanical citation
// corroboration, the citations-vs-annotations reconcile (honesty rule: a
// citation URL the model invented is dropped), and the strict-envelope
// parse shared by the executor.

import { describe, expect, it } from "vitest";
import type { WebCitation } from "@jehad/adapters";
import {
  normalizeUrlForMatch,
  parseJsonEnvelope,
  reconcileWebCitations,
} from "./research-web.js";

describe("normalizeUrlForMatch", () => {
  it("lowercases the host while preserving the path case", () => {
    expect(normalizeUrlForMatch("https://EXAMPLE.com/Reports/Q3")).toBe(
      "https://example.com/Reports/Q3",
    );
  });

  it("strips the hash fragment", () => {
    expect(normalizeUrlForMatch("https://example.com/a#section")).toBe(
      "https://example.com/a",
    );
    expect(normalizeUrlForMatch("https://example.com/a#")).toBe(
      "https://example.com/a",
    );
  });

  it("strips the trailing slash (including several)", () => {
    expect(normalizeUrlForMatch("https://example.com/a/")).toBe(
      "https://example.com/a",
    );
    expect(normalizeUrlForMatch("https://example.com/a///")).toBe(
      "https://example.com/a",
    );
    expect(normalizeUrlForMatch("https://example.com/")).toBe(
      "https://example.com",
    );
  });

  it("keeps the query string", () => {
    expect(normalizeUrlForMatch("https://example.com/a?q=1&lang=en")).toBe(
      "https://example.com/a?q=1&lang=en",
    );
  });

  it("collapses formatting-only variants to one canonical form", () => {
    const canonical = normalizeUrlForMatch("https://example.com/a?q=1");
    expect(normalizeUrlForMatch("https://EXAMPLE.com/a/?q=1#ref")).toBe(canonical);
    expect(normalizeUrlForMatch("https://example.com/a?q=1")).toBe(canonical);
  });

  it("falls back to trimmed lowercase for unparseable input", () => {
    expect(normalizeUrlForMatch("  not a url  ")).toBe("not a url");
  });
});

describe("reconcileWebCitations", () => {
  const annotation = (url: string, title?: string): WebCitation =>
    title === undefined ? { url } : { url, title };

  it("keeps a url citation corroborated by an exact annotation match", () => {
    const result = reconcileWebCitations(
      [{ ref: "source-1", url: "https://good.example/a", note: "supports the claim" }],
      [annotation("https://good.example/a", "Good")],
    );
    expect(result.dropped).toBe(0);
    expect(result.kept).toEqual([
      { ref: "source-1", url: "https://good.example/a", note: "supports the claim", title: "Good" },
    ]);
  });

  it("matches normalization variants (trailing slash, host case, hash)", () => {
    const result = reconcileWebCitations(
      [
        { ref: "s-slash", url: "https://good.example/a/" },
        { ref: "s-case", url: "https://GOOD.example/b" },
        { ref: "s-hash", url: "https://good.example/c#top" },
      ],
      [
        annotation("https://good.example/a"),
        annotation("https://good.example/b/"),
        annotation("https://good.example/c"),
      ],
    );
    expect(result.dropped).toBe(0);
    expect(result.kept.map((c) => c.ref)).toEqual(["s-slash", "s-case", "s-hash"]);
  });

  it("drops an invented url citation and counts it", () => {
    const result = reconcileWebCitations(
      [{ ref: "source-2", url: "https://invented.example/b", title: "Fabricated" }],
      [annotation("https://good.example/a")],
    );
    expect(result.kept).toEqual([]);
    expect(result.dropped).toBe(1);
  });

  it("backfills a missing title from the matching annotation", () => {
    const result = reconcileWebCitations(
      [{ ref: "source-1", url: "https://good.example/a" }],
      [annotation("https://good.example/a", "The Good Page")],
    );
    expect(result.kept).toEqual([
      { ref: "source-1", url: "https://good.example/a", title: "The Good Page" },
    ]);
  });

  it("never overwrites a citation title the worker supplied", () => {
    const result = reconcileWebCitations(
      [{ ref: "source-1", url: "https://good.example/a", title: "Worker Title" }],
      [annotation("https://good.example/a", "Annotation Title")],
    );
    expect(result.kept).toEqual([
      { ref: "source-1", url: "https://good.example/a", title: "Worker Title" },
    ]);
  });

  it("passes non-url citations through untouched (package-block grounding)", () => {
    const result = reconcileWebCitations(
      [
        { ref: "gmail.metadata.recent — billing@acme.com", note: "sender context" },
        { ref: "memory.relevant — plaid", title: "Memory block" },
      ],
      [],
    );
    expect(result.dropped).toBe(0);
    expect(result.kept).toEqual([
      { ref: "gmail.metadata.recent — billing@acme.com", note: "sender context" },
      { ref: "memory.relevant — plaid", title: "Memory block" },
    ]);
  });

  it("handles a mixed kept/dropped set with accurate counts", () => {
    const result = reconcileWebCitations(
      [
        { ref: "block-a", note: "package grounding" },
        { ref: "source-1", url: "https://good.example/a" },
        { ref: "source-2", url: "https://invented.example/b" },
        { ref: "source-3", url: "https://also-invented.example/c" },
      ],
      [annotation("https://good.example/a", "Good")],
    );
    expect(result.dropped).toBe(2);
    expect(result.kept).toEqual([
      { ref: "block-a", note: "package grounding" },
      { ref: "source-1", url: "https://good.example/a", title: "Good" },
    ]);
  });

  it("counts malformed entries (non-objects, missing/empty refs) as dropped", () => {
    const result = reconcileWebCitations(
      [42, null, "a string", { url: "https://good.example/a" }, { ref: "" }, { ref: "ok" }],
      [annotation("https://good.example/a")],
    );
    expect(result.dropped).toBe(5);
    expect(result.kept).toEqual([{ ref: "ok" }]);
  });

  it("ignores annotations without a usable url", () => {
    const result = reconcileWebCitations(
      [{ ref: "source-1", url: "https://good.example/a" }],
      [{ url: "" }, annotation("https://good.example/a")],
    );
    expect(result.dropped).toBe(0);
    expect(result.kept).toHaveLength(1);
  });

  it("returns empty kept for empty input", () => {
    expect(reconcileWebCitations([], [annotation("https://good.example/a")])).toEqual({
      kept: [],
      dropped: 0,
    });
  });
});

describe("parseJsonEnvelope", () => {
  it("parses a plain single-line JSON object", () => {
    expect(parseJsonEnvelope('{"summary":"ok"}')).toEqual({ summary: "ok" });
  });

  it("strips ```json fences", () => {
    const text = '```json\n{"summary":"ok","confidence":0.9}\n```';
    expect(parseJsonEnvelope(text)).toEqual({ summary: "ok", confidence: 0.9 });
  });

  it("strips bare ``` fences (no language tag)", () => {
    const text = '```\n{"summary":"ok"}\n```';
    expect(parseJsonEnvelope(text)).toEqual({ summary: "ok" });
  });

  it("accepts a fenced object on one line", () => {
    expect(parseJsonEnvelope('```json {"a":1} ```')).toEqual({ a: 1 });
  });

  it("returns null for arrays (never a valid result envelope)", () => {
    expect(parseJsonEnvelope('[{"a":1}]')).toBeNull();
  });

  it("returns null for a JSON null literal", () => {
    expect(parseJsonEnvelope("null")).toBeNull();
  });

  it("returns null for non-object JSON values", () => {
    expect(parseJsonEnvelope("42")).toBeNull();
    expect(parseJsonEnvelope('"just a string"')).toBeNull();
    expect(parseJsonEnvelope("true")).toBeNull();
  });

  it("returns null for unparseable text", () => {
    expect(parseJsonEnvelope("not json at all")).toBeNull();
    expect(parseJsonEnvelope('{"summary": truncated')).toBeNull();
    expect(parseJsonEnvelope("")).toBeNull();
  });
});
