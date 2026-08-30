import { describe, expect, it } from "vitest";

import { relativeTime } from "../lib/relative-time";

/**
 * Dates are where off-by-one reads as a bug to the person looking at it:
 * "cooked 0 days ago" is nonsense on a page they trust for their own history.
 */
const NOW = new Date("2026-08-28T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("relativeTime", () => {
  it("never says zero of anything", () => {
    expect(relativeTime(ago(0), NOW)).toBe("just now");
    expect(relativeTime(ago(30_000), NOW)).toBe("just now");
    expect(relativeTime(ago(59_000), NOW)).toBe("just now");
  });

  it("never reads as the future, even with clock skew", () => {
    // A row written a second ahead of this machine's clock must not render
    // "in 1 second" on a page about something that already happened.
    expect(relativeTime(new Date(NOW.getTime() + 5_000), NOW)).toBe("just now");
  });

  it.each([
    [MINUTE, "1 minute ago"],
    [5 * MINUTE, "5 minutes ago"],
    [HOUR, "1 hour ago"],
    [3 * HOUR, "3 hours ago"],
  ])("renders %i ms as %s", (delta, expected) => {
    expect(relativeTime(ago(delta), NOW)).toBe(expected);
  });

  it("says yesterday rather than 1 day ago", () => {
    expect(relativeTime(ago(DAY), NOW)).toBe("yesterday");
    expect(relativeTime(ago(1.5 * DAY), NOW)).toBe("yesterday");
  });

  it("counts days up to a week, then weeks", () => {
    expect(relativeTime(ago(3 * DAY), NOW)).toBe("3 days ago");
    expect(relativeTime(ago(6 * DAY), NOW)).toBe("6 days ago");
    expect(relativeTime(ago(7 * DAY), NOW)).toBe("1 week ago");
    expect(relativeTime(ago(21 * DAY), NOW)).toBe("3 weeks ago");
  });

  it("switches to calendar months, not 30-day blocks", () => {
    // Someone who cooked this on the 3rd of last month expects "1 month ago",
    // not "4 weeks ago" — the calendar is what they actually remember.
    expect(relativeTime(new Date("2026-07-03T12:00:00Z"), NOW)).toBe("1 month ago");
    expect(relativeTime(new Date("2026-02-28T12:00:00Z"), NOW)).toBe("6 months ago");
  });

  it("never says 0 months at a month boundary", () => {
    // 2026-08-01 to 2026-08-28 is the same calendar month: 27 days, so weeks.
    expect(relativeTime(new Date("2026-08-01T12:00:00Z"), NOW)).toBe("3 weeks ago");
  });

  it("counts years past twelve months", () => {
    expect(relativeTime(new Date("2025-08-28T12:00:00Z"), NOW)).toBe("1 year ago");
    expect(relativeTime(new Date("2024-01-01T12:00:00Z"), NOW)).toBe("2 years ago");
  });
});
