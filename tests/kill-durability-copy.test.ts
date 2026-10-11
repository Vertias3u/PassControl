import { describe, expect, it } from "vitest";
import { notDurableMessage, notDurableRetryLabel } from "@/lib/kill-durability";

// The warning shown when a stop changed in Redis but not in its durable record
// (0083). Its first draft ended "Press it again to save it", and the live check
// caught it: beside a STOPPED control the one button lifts the stop. So the copy
// names no button, and each control carries its own same-intent retry.
describe("the not-saved warning", () => {
  it("says the stop is in force (or lifted) and what a Redis loss would do", () => {
    expect(notDurableMessage(true)).toMatch(/^In force, but not saved/);
    expect(notDurableMessage(true)).toMatch(/this stop is lifted/);
    expect(notDurableMessage(false)).toMatch(/^Lifted, but/);
    expect(notDurableMessage(false)).toMatch(/this stop comes back/);
  });

  it("never sends the operator to the button that would undo the stop", () => {
    for (const armed of [true, false]) expect(notDurableMessage(armed)).not.toMatch(/press|click|button/i);
  });

  it("labels the retry by the intent it re-sends", () => {
    expect(notDurableRetryLabel(true)).toBe("Try saving again");
    expect(notDurableRetryLabel(false)).toBe("Try clearing again");
  });
});
