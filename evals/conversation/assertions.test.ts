import { describe, expect, it } from "vitest";
import { PERSISTENCE_CLAIM_RE, persistenceClaimIn } from "./assertions.js";

describe("PERSISTENCE_CLAIM_RE (W6(c) invariant 15)", () => {
  it.each([
    "I've noted your message.",
    "I have noted the tasks.",
    "I've saved that.",
    "I have saved the list.",
    "I've added them.",
    "I have updated the commitment.",
    "I've added the wedding tasks.",
    "I'll remember that.",
    "I will not — but I'll remember the date.",
    "I'm tracking them now.",
    "Sure — i'm tracking the three deadlines.",
    "Got it, I've noted it all.",
  ])("flags the claim: %s", (reply) => {
    expect(PERSISTENCE_CLAIM_RE.test(reply)).toBe(true);
    expect(persistenceClaimIn(reply)).not.toBeNull();
  });

  it.each([
    // Honest no-write wording (§5-15's prescribed sentence and friends).
    "I see it in our conversation, but I'm not tracking it yet.",
    "I'm not tracking these yet — say \"track them\" and I will add them.",
    "Nothing was written yet.",
    "I can stage that, but it only takes effect once you approve it.",
    // Bare verbs without the first-person claim frame.
    "Noted above in our chat only.",
    "The tasks are listed in your message.",
    // Look-alikes that must not match.
    "We've noted concerns about the venue before.",
    "Remember to bring the seating chart.",
    "Tracking numbers arrive by email.",
    "You saved that already last week.",
    "I remember no such decision.",
  ])("allows the honest/neutral wording: %s", (reply) => {
    expect(PERSISTENCE_CLAIM_RE.test(reply)).toBe(false);
    expect(persistenceClaimIn(reply)).toBeNull();
  });

  it("returns the matched phrase for failure messages", () => {
    expect(persistenceClaimIn("Sounds good — I've noted it.")).toBe("I've noted");
    expect(persistenceClaimIn("I'm tracking eight items.")).toBe("I'm tracking");
    expect(persistenceClaimIn("clean reply")).toBeNull();
  });
});
