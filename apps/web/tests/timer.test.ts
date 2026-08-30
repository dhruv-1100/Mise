import { describe, expect, it } from "vitest";

import {
  describeDuration,
  formatCountdown,
  formatDuration,
  hasExpired,
  remainingSeconds,
} from "../lib/timer";

/**
 * A kitchen timer that is wrong is worse than no timer, and the arithmetic is
 * the part that can be wrong. The component is untestable per CLAUDE.md; this
 * is the part that isn't.
 */
describe("remainingSeconds", () => {
  const START = 1_700_000_000_000;

  it("counts down from the end timestamp", () => {
    expect(remainingSeconds(START + 600_000, START)).toBe(600);
    expect(remainingSeconds(START + 600_000, START + 60_000)).toBe(540);
  });

  it("never goes negative, however late you come back", () => {
    // The case that matters: the phone was locked for an hour during a
    // ten-minute timer.
    expect(remainingSeconds(START + 600_000, START + 3_600_000)).toBe(0);
  });

  it("rounds up, so a fresh timer reads its full duration", () => {
    // Ceil not floor: at 599.4s left, a cook expects to see 10:00 tick to
    // 09:59, not to open on 09:59.
    expect(remainingSeconds(START + 599_400, START)).toBe(600);
  });

  it("is derived from wall clock, so a slept tab loses nothing", () => {
    // This is the whole reason the module exists. A decrementing counter that
    // was throttled for five minutes would be five minutes slow; recomputing
    // from the end timestamp cannot be.
    const endsAt = START + 900_000;
    const afterSleep = START + 300_000;
    expect(remainingSeconds(endsAt, afterSleep)).toBe(600);
  });
});

describe("hasExpired", () => {
  it("is true at exactly zero, not one tick later", () => {
    expect(hasExpired(1000, 999)).toBe(false);
    expect(hasExpired(1000, 1000)).toBe(true);
    expect(hasExpired(1000, 5_000_000)).toBe(true);
  });
});

describe("formatCountdown", () => {
  it.each([
    [600, "10:00"],
    [59, "00:59"],
    [0, "00:00"],
    [61, "01:01"],
  ])("renders %i seconds as %s", (input, expected) => {
    expect(formatCountdown(input)).toBe(expected);
  });

  it("keeps a fixed width so the digits do not jump at arm's length", () => {
    expect(formatCountdown(9)).toBe("00:09");
    expect(formatCountdown(599)).toBe("09:59");
  });

  it("shows hours only when there are hours", () => {
    // A 5-minute timer reading 00:05:00 wastes the glyphs that matter.
    expect(formatCountdown(3600)).toBe("1:00:00");
    expect(formatCountdown(7325)).toBe("2:02:05");
    expect(formatCountdown(3599)).toBe("59:59");
  });

  it("does not render a negative clock", () => {
    expect(formatCountdown(-30)).toBe("00:00");
  });
});

describe("formatDuration", () => {
  it("labels a duration the way a recipe writes it", () => {
    expect(formatDuration(600)).toBe("10 min");
    expect(formatDuration(45)).toBe("45s");
    expect(formatDuration(90)).toBe("1:30");
  });
});

describe("describeDuration", () => {
  it("is spoken, not punctuated — it goes to a screen reader", () => {
    expect(describeDuration(600)).toBe("10 minutes");
    expect(describeDuration(60)).toBe("1 minute");
    expect(describeDuration(90)).toBe("1 minute 30 seconds");
    expect(describeDuration(45)).toBe("45 seconds");
    expect(describeDuration(0)).toBe("0 seconds");
  });
});
