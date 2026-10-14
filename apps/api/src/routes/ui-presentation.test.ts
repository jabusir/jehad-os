/**
 * U0 foundations — ui-presentation unit tests (pure, no DB): the language
 * map, relative/local time formatting, page chrome (aria-current segmented
 * nav), design-token CSS invariants, remedy error pages, flash banners, and
 * empty-state CTAs.
 */

import { describe, expect, it } from "vitest";
import {
  UI_CSS,
  doneBannerText,
  emptyState,
  errorPage,
  flashBanner,
  formatLocalTime,
  humanizeCriterion,
  humanizeStatus,
  page,
  relativeTime,
  statusPill,
  timeAttr,
} from "./ui-presentation.js";

describe("language map (render-time only)", () => {
  it("humanizes the canonical outcome statuses; unknown values pass through raw", () => {
    expect(humanizeStatus("waiting_user")).toBe("Waiting for you");
    expect(humanizeStatus("blocked")).toBe("Blocked");
    expect(humanizeStatus("verifying")).toBe("Verifying");
    expect(humanizeStatus("completed")).toBe("Done");
    expect(humanizeStatus("failed")).toBe("Failed");
    expect(humanizeStatus("cancelled")).toBe("Cancelled");
    // "In motion" variants
    expect(humanizeStatus("running")).toBe("In motion");
    expect(humanizeStatus("accepted")).toContain("In motion");
    expect(humanizeStatus("queued")).toContain("In motion");
    expect(humanizeStatus("waiting_external")).toContain("In motion");
    // unknown canonical value → raw passthrough (fail-open display only)
    expect(humanizeStatus("some_future_status")).toBe("some_future_status");
  });

  it("statusPill renders the humanized label with a semantic family class", () => {
    expect(statusPill("waiting_user")).toBe(
      `<span class="pill pill-needs">Waiting for you</span>`,
    );
    expect(statusPill("running")).toContain("pill-motion");
    expect(statusPill("completed")).toContain("pill-done");
    expect(statusPill("failed")).toContain("pill-failed");
    // pill labels are escaped
    expect(statusPill("<x>")).toContain("&lt;x&gt;");
  });

  it("humanizes criterion statuses for the detail view", () => {
    expect(humanizeCriterion("pending")).toBe("Not verified yet");
    expect(humanizeCriterion("verified")).toBe("Verified");
    expect(humanizeCriterion("waived_by_owner")).toBe("Waived by you");
    expect(humanizeCriterion("future_kind")).toBe("future_kind");
  });
});

describe("relative + local time", () => {
  const now = new Date("2026-10-13T15:57:00");

  it("formats fresh timestamps relatively", () => {
    expect(relativeTime(new Date("2026-10-13T15:56:30"), now)).toBe("just now");
    expect(relativeTime(new Date("2026-10-13T15:52:00"), now)).toBe("5m ago");
    expect(relativeTime(new Date("2026-10-13T13:57:00"), now)).toBe("2h ago");
    expect(relativeTime(new Date("2026-10-11T15:57:00"), now)).toBe("2d ago");
  });

  it("flips to a short local weekday stamp after 7 days", () => {
    const old = new Date("2026-09-29T15:57:00");
    const stamp = relativeTime(old, now);
    expect(stamp).toMatch(/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) \d{1,2}:\d{2} (AM|PM)$/);
    const expectedWeekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][old.getDay()];
    expect(stamp.startsWith(expectedWeekday)).toBe(true);
  });

  it("formatLocalTime renders the absolute server-local stamp", () => {
    const stamp = formatLocalTime("2026-10-13T15:57:00");
    expect(stamp).toBe(`${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][2]} Oct 13, 3:57 PM`);
  });

  it("timeAttr carries the absolute ISO — the only place ISO may appear", () => {
    expect(timeAttr("2026-10-13T15:57:00.000Z")).toBe(
      `datetime="2026-10-13T15:57:00.000Z" title="2026-10-13T15:57:00.000Z"`,
    );
    // hostile input cannot break out of the attribute
    expect(timeAttr(`" onmouseover="x`)).not.toContain(`" onmouseover`);
  });
});

describe("page chrome", () => {
  it("renders the segmented nav with aria-current on the active item only", () => {
    const todayMarkup = page("x", { path: "/ui" }).split("</style>")[1] ?? "";
    expect(todayMarkup).toContain(`href="/ui" aria-current="page"`);
    expect(todayMarkup).not.toContain(`href="/ui/delegate" aria-current="page"`);
    expect(todayMarkup).toContain(`href="/ui/delegate">Delegate</a>`);

    const missionsMarkup = page("x", { path: "/ui/missions" }).split("</style>")[1] ?? "";
    expect(missionsMarkup).toContain(`href="/ui/missions" aria-current="page"`);
    expect(missionsMarkup).not.toContain(`href="/ui" aria-current="page"`);
  });

  it("omits aria-current when no path is given (e.g. delegate until lane C)", () => {
    const bareMarkup = page("x").split("</style>")[1] ?? "";
    expect(bareMarkup).not.toContain("aria-current");
    expect(bareMarkup).toContain(`href="/ui/delegate"`);
  });

  it("keeps the security head: viewport meta, no script, no external assets", () => {
    const html = page("x", { path: "/ui" });
    expect(html).toContain(`<meta name="viewport" content="width=device-width, initial-scale=1">`);
    // U3: exactly ONE script — the inline, CSP-hashed enhancement (no src, no
    // external asset). Everything else stays script-free.
    expect((html.match(/<script/g) ?? [])).toHaveLength(1);
    expect(html).not.toContain('<script src=');
    expect(html).not.toContain("http://");
    expect(html).not.toContain("https://");
  });
});

describe("design tokens (CSS invariants)", () => {
  it("carries dark mode, reduced-motion, safe-area, blur, and the type scale", () => {
    expect(UI_CSS).toContain("prefers-color-scheme:dark");
    expect(UI_CSS).toContain("prefers-reduced-motion:reduce");
    expect(UI_CSS).toContain("env(safe-area-inset-top)");
    expect(UI_CSS).toContain("env(safe-area-inset-right)");
    expect(UI_CSS).toContain("env(safe-area-inset-bottom)");
    expect(UI_CSS).toContain("env(safe-area-inset-left)");
    expect(UI_CSS).toContain("backdrop-filter");
    expect(UI_CSS).toContain("position:sticky");
    expect(UI_CSS).toContain("--size-body:17px");
    expect(UI_CSS).toContain("--size-secondary:15px");
    expect(UI_CSS).toContain("--size-caption:13px");
    expect(UI_CSS).toContain("system-ui");
    expect(UI_CSS).toContain("border-radius:12px"); // inset-grouped cards
    expect(UI_CSS).toContain("160ms ease-out"); // 150–200ms ease-out window
    expect(UI_CSS).toContain("aria-current");
  });
});

describe("flash banners (?done aftermath copy)", () => {
  it("names the aftermath for every known action and nulls unknown actions", () => {
    expect(doneBannerText("resolve")).toContain("Resolved");
    expect(doneBannerText("dismiss")).toContain("Dismissed");
    expect(doneBannerText("seen")).toContain("Marked seen");
    expect(doneBannerText("snooze")).toContain("Snoozed");
    expect(doneBannerText("feedback")).toContain("feedback");
    expect(doneBannerText("bogus")).toBeNull();
  });

  it("renders one dismissible banner (details-based, no JS)", () => {
    const banner = flashBanner(doneBannerText("resolve")!);
    expect(banner).toContain(`<details class="flash" open>`);
    expect(banner).toContain("Resolved");
    expect(banner).not.toContain("<script");
  });
});

describe("error pages + empty states", () => {
  it("errorPage shows what happened → remedy → way back", () => {
    const html = errorPage({
      heading: "That card isn't available",
      what: "It may already be resolved.",
      remedy: "Reopen Today.",
      backHref: "/ui",
      backLabel: "Back to Today",
      navPath: "/ui",
    });
    expect(html).toContain("That card isn&#39;t available"); // heading is escaped
    expect(html).toContain("It may already be resolved.");
    expect(html).toContain("Reopen Today.");
    expect(html).toContain(`href="/ui"`);
    expect(html).toContain("Back to Today");
    expect(html).toContain(`href="/ui" aria-current="page"`);
    // everything escaped
    expect(errorPage({ heading: "<h>", what: "<w>", remedy: "<r>" })).toContain("&lt;h&gt;");
  });

  it("emptyState renders the CTA button when given", () => {
    const withCta = emptyState("Nothing needs you right now.", "Delegate something", "/ui/delegate");
    expect(withCta).toContain("Nothing needs you right now.");
    expect(withCta).toContain(`class="btn btn-primary" href="/ui/delegate"`);
    expect(withCta).toContain("Delegate something");
    expect(emptyState("Nothing snoozed.")).not.toContain("btn");
  });
});
