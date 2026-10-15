// Pure unit tests for the public-web URL guard (mission-execution v1):
// a citation's url, when present, must be a PUBLIC http(s) URL — loopback,
// private/link-local/CGNAT ranges, reserved single-label and .local-style
// hosts, and userinfo-bearing URLs all fail closed (return null).

import { describe, expect, it } from "vitest";
import { RESULT_CITATION_URL_MAX_CHARS, publicWebUrl } from "./service.js";

describe("publicWebUrl (mission-execution v1 citation guard)", () => {
  it("accepts public http(s) URLs", () => {
    expect(publicWebUrl("https://example.com/a")).toBe("https://example.com/a");
    expect(publicWebUrl("http://example.com")).toBe("http://example.com/");
    expect(publicWebUrl("https://sub.domain.example.org/page?q=1#frag")).toBe(
      "https://sub.domain.example.org/page?q=1#frag",
    );
  });

  it("accepts public IPv4 hosts outside every reserved range", () => {
    expect(publicWebUrl("https://8.8.8.8/dns-query")).toBe("https://8.8.8.8/dns-query");
    expect(publicWebUrl("http://172.32.0.1/x")).toBe("http://172.32.0.1/x");
    expect(publicWebUrl("http://100.128.0.1/x")).toBe("http://100.128.0.1/x");
    expect(publicWebUrl("http://169.255.1.1/x")).toBe("http://169.255.1.1/x");
  });

  it("round-trips to a normalized absolute URL", () => {
    expect(publicWebUrl("https://EXAMPLE.com/Path")).toBe("https://example.com/Path");
    expect(publicWebUrl("https://example.com:8443/x")).toBe("https://example.com:8443/x");
    // Not absolute URLs are rejected, never "fixed".
    expect(publicWebUrl("example.com/a")).toBeNull();
    expect(publicWebUrl("//example.com/a")).toBeNull();
    expect(publicWebUrl("/relative/path")).toBeNull();
  });

  it("rejects non-string and empty input", () => {
    expect(publicWebUrl(undefined)).toBeNull();
    expect(publicWebUrl(null)).toBeNull();
    expect(publicWebUrl(42)).toBeNull();
    expect(publicWebUrl({ url: "https://example.com" })).toBeNull();
    expect(publicWebUrl("")).toBeNull();
  });

  it("rejects non-http(s) schemes", () => {
    expect(publicWebUrl("ftp://example.com/file")).toBeNull();
    expect(publicWebUrl("file:///etc/passwd")).toBeNull();
    expect(publicWebUrl("javascript:alert(1)")).toBeNull();
  });

  it("rejects single-label and localhost-style hosts", () => {
    expect(publicWebUrl("http://localhost/x")).toBeNull();
    expect(publicWebUrl("http://localhost:8080/x")).toBeNull();
    expect(publicWebUrl("https://intranet/x")).toBeNull();
    expect(publicWebUrl("https://corp/x")).toBeNull();
    expect(publicWebUrl("https://myserver/x")).toBeNull();
  });

  it("rejects .local/.internal/.localhost/.home.arpa suffixes", () => {
    expect(publicWebUrl("https://printer.local/x")).toBeNull();
    expect(publicWebUrl("https://api.internal/x")).toBeNull();
    expect(publicWebUrl("https://foo.localhost/x")).toBeNull();
    expect(publicWebUrl("https://box.home.arpa/x")).toBeNull();
  });

  it("rejects URLs carrying userinfo", () => {
    expect(publicWebUrl("https://user:pass@example.com/x")).toBeNull();
    expect(publicWebUrl("https://user@example.com/x")).toBeNull();
  });

  it("rejects reserved IPv4 ranges (0/8, 10/8, 127/8, 169.254/16, 172.16/12, 192.168/16, 100.64/10)", () => {
    for (const host of [
      "0.1.2.3",
      "10.0.0.5",
      "10.255.255.255",
      "127.0.0.1",
      "127.8.8.8",
      "169.254.1.1",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "100.64.0.1",
      "100.127.255.255",
    ]) {
      expect(publicWebUrl(`https://${host}/x`), host).toBeNull();
    }
  });

  it("rejects reserved IPv6 literals (::1, ::, fc00::/7, fe80::/10)", () => {
    for (const host of ["[::1]", "[::]", "[fc00::1]", "[fd12:3456::1]", "[fe80::1]", "[febf::1]"]) {
      expect(publicWebUrl(`http://${host}:8080/x`), host).toBeNull();
    }
  });

  it("enforces the 2048-char URL bound (boundary accepted, over rejected)", () => {
    const prefix = "https://example.com/";
    const boundary = prefix + "a".repeat(RESULT_CITATION_URL_MAX_CHARS - prefix.length);
    expect(boundary).toHaveLength(RESULT_CITATION_URL_MAX_CHARS);
    expect(publicWebUrl(boundary)).toBe(boundary);
    expect(publicWebUrl(boundary + "a")).toBeNull();
  });
});
