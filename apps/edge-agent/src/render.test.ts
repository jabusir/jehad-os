// Regression tests for the 2026-09-22 envelope leak (owner directive
// "calibration message quality fix" §1/§14): a calibration notification's
// transport envelope (payload keys + serialized JSON) was delivered to
// iMessage verbatim because kind=calibration fell into the default
// projection. These pin the invariant: NO kind ever renders its payload
// serialization, and calibration/reply render human content only.

import { describe, expect, it } from "vitest";
import {
  renderNotificationText,
  type DeliverableNotification,
} from "./render.js";

/** An envelope-shaped payload: internal routing/audit fields + content. */
function envelopePayload(content: string): Record<string, unknown> {
  return {
    content,
    surface: "imessage",
    periodDate: "2026-09-22",
    calibrationItemId: "0d9a6c47-0f8e-4a4a-9d86-9f0aa2eb2cf1",
  };
}

function notif(kind: string, payload: Record<string, unknown>, title = "Daily calibration check"): DeliverableNotification {
  return { id: "n-1", kind, title, payload };
}

const ENVELOPE_FRAGMENTS = [
  '"content"',
  '"surface"',
  '"periodDate"',
  '"calibrationItemId"',
  "calibrationItemId",
  "imessage",
  "2026-09-22",
  "0d9a6c47",
];

describe("renderNotificationText — transport envelope never user-visible", () => {
  it("calibration renders content only — the 2026-09-22 leak pinned", () => {
    const text = renderNotificationText(
      notif("calibration", envelopePayload("Jehad OS — daily check\n\nWhat I could verify:\n• the outcome completed")),
    );
    expect(text).toBe("Jehad OS — daily check\n\nWhat I could verify:\n• the outcome completed");
  });

  it("calibration with a payload that is pure JSON never leaks the serialization", () => {
    // Pathological upstream bug: content itself serialized — the renderer
    // must not make it worse (it passes through as content; keys of the
    // ENVELOPE must still not appear as an envelope).
    const text = renderNotificationText(
      notif("calibration", { content: "hello" }),
    );
    expect(text).toBe("hello");
    expect(text).not.toContain("{");
  });

  it("unknown kinds degrade to the title — never a payload JSON dump", () => {
    const payload = { content: "hi", surface: "imessage", secretField: "x" };
    const text = renderNotificationText(notif("some-future-kind", payload, "Fallback title"));
    expect(text).toBe("Fallback title");
    expect(text).not.toContain("secretField");
    expect(text).not.toContain("{");
  });

  it("every registered kind keeps envelope fragments out of rendered text", () => {
    const kinds = ["brief", "reply", "calibration", "calendar-change", "escalation", "unknown-future"];
    for (const kind of kinds) {
      const text = renderNotificationText(notif(kind, envelopePayload("Human copy only")));
      for (const fragment of ENVELOPE_FRAGMENTS) {
        expect(text, `${kind} leaked envelope fragment "${fragment}"`).not.toContain(fragment);
      }
      expect(text).not.toMatch(/\{.*\}/s);
    }
  });

  it("brief renders title + content without payload keys", () => {
    const text = renderNotificationText(notif("brief", envelopePayload("Evening brief body"), "Evening brief"));
    expect(text).toBe("Evening brief\nEvening brief body");
  });

  it("reply renders content only (owner feedback 2026-09-19, unchanged)", () => {
    const text = renderNotificationText(notif("reply", envelopePayload("chat body"), "Reply"));
    expect(text).toBe("chat body");
  });

  // W1 attention kind (ADR-0018 §4): title + content + whyItMatters + the
  // Review-in-Today line, exactly per the payload contract — and never the
  // envelope.
  it("attention renders title + content + whyItMatters + Review-in-Today line", () => {
    const text = renderNotificationText(
      notif(
        "attention",
        {
          content: "Chase the Acme quote — ready for your judgment",
          whyItMatters: "Delegated work needs your decision to continue.",
          todayUrl: "https://jehad.ts.net/ui#item-6f0c",
        },
        "Chase the Acme quote — ready for your judgment",
      ),
    );
    expect(text).toBe(
      "Chase the Acme quote — ready for your judgment\n" +
        "Chase the Acme quote — ready for your judgment\n" +
        "Delegated work needs your decision to continue.\n" +
        "Review in Today: https://jehad.ts.net/ui#item-6f0c",
    );
  });

  // W1.2 audit fix: the daily brief carries the Today tap-through when
  // deployed — the owner can jump from the daily message to the product.
  it("brief renders title + content + Open-in-Today line when todayUrl is in the payload", () => {
    const text = renderNotificationText(
      notif(
        "brief",
        { content: "Morning brief — Tue, Oct 13", artifactId: "a-1", todayUrl: "https://jehad.ts.net/ui" },
        "Morning brief",
      ),
    );
    expect(text).toBe("Morning brief\nMorning brief — Tue, Oct 13\nOpen in Today: https://jehad.ts.net/ui");
  });

  it("brief without a deployed Today URL stays title + content", () => {
    const text = renderNotificationText(
      notif("brief", { content: "Evening close — Mon, Oct 12" }, "Evening close"),
    );
    expect(text).toBe("Evening close\nEvening close — Mon, Oct 12");
    expect(text).not.toContain("Open in Today");
  });

  it("attention without a deployed Today URL omits the Review line", () => {
    const text = renderNotificationText(
      notif("attention", { content: "body copy", whyItMatters: "why copy" }, "attention title"),
    );
    expect(text).toBe("attention title\nbody copy\nwhy copy");
    expect(text).not.toContain("Review in Today");
  });

  it("attention respects the iMessage truncation cap and never leaks payload JSON", () => {
    const long = "x".repeat(2400);
    const text = renderNotificationText(
      notif(
        "attention",
        { content: long, whyItMatters: "why", todayUrl: "https://jehad.ts.net/ui#item-x", surface: "imessage" },
        "attention title",
      ),
    );
    expect(text.length).toBe(1500);
    expect(text.endsWith("…[truncated]")).toBe(true);
    for (const fragment of ENVELOPE_FRAGMENTS) {
      expect(text, `attention leaked envelope fragment "${fragment}"`).not.toContain(fragment);
    }
    expect(text).not.toMatch(/\{.*\}/s);
  });
});
