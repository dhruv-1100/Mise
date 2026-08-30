/**
 * Checked against the SAME fixture as `apps/extractor/tests/test_units.py`.
 *
 * Two hand-written conversion tables is the drift this repo already guards
 * against for the recipe contract. A factor changed on one side and not the
 * other fails here and there.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { classifyUnit, isMetric, toMetric } from "../src/convert";

const FIXTURE = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "..", "..", "schema", "fixtures", "units", "conversions.json",
);

interface Fixture {
  mass: { unit: string; qty: number; grams: number }[];
  volume: { unit: string; qty: number; millilitres: number }[];
  ambiguous: string[];
  not_convertible: { unit: string | null; why: string }[];
}

const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as Fixture;

/** The fixture is exact; the display conversion rounds. Compare the underlying value. */
function grams(converted: { qty: number; unit: string }): number {
  return converted.unit === "kg" ? converted.qty * 1000 : converted.qty;
}
function millilitres(converted: { qty: number; unit: string }): number {
  return converted.unit === "l" ? converted.qty * 1000 : converted.qty;
}

/**
 * How far the display value may sit from the exact one.
 *
 * Rounding is deliberate — a reader wants "3.79 l", not "3785.411784 ml" — so
 * the test states the loss it accepts rather than pretending there is none.
 * 0.2% covers 2dp at the promoted kg/l scale (a gallon rounds to 3.79 l, which
 * is 4.6 ml out); the 0.5 floor covers small amounts displayed whole.
 */
function withinDisplayRounding(actual: number, expected: number): void {
  const tolerance = Math.max(0.5, expected * 0.002);
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance);
}

describe("the shared fixture", () => {
  it("is not empty, which would make this file a no-op that reports green", () => {
    expect(fixture.mass.length).toBeGreaterThan(0);
    expect(fixture.volume.length).toBeGreaterThan(0);
    expect(fixture.not_convertible.length).toBeGreaterThan(0);
  });
});

describe("mass", () => {
  it.each(fixture.mass)("$qty $unit is $grams g", ({ unit, qty, grams: expected }) => {
    const got = toMetric(qty, unit);
    expect(got).not.toBeNull();
    expect(classifyUnit(unit)).toBe("mass");
    // Rounded for display, so compare within the rounding the formatter applies.
    withinDisplayRounding(grams(got!), expected);
  });
});

describe("volume", () => {
  it.each(fixture.volume)("$qty $unit is $millilitres ml", ({ unit, qty, millilitres: expected }) => {
    const got = toMetric(qty, unit);
    expect(got).not.toBeNull();
    expect(classifyUnit(unit)).toBe("volume");
    withinDisplayRounding(millilitres(got!), expected);
  });
});

describe("what must NOT be converted", () => {
  it.each(fixture.not_convertible)("refuses $unit — $why", ({ unit }) => {
    // Inventing a gram value for "a pinch" or "2 cloves" would be the same
    // failure as inventing a quantity: a number nobody stated.
    expect(toMetric(2, unit)).toBeNull();
  });

  it("refuses a vague quantity however well-known the unit", () => {
    expect(toMetric(null, "cup")).toBeNull();
    expect(toMetric(null, "g")).toBeNull();
  });
});

describe("regional ambiguity", () => {
  it.each(fixture.ambiguous)("flags %s as approximate", (unit) => {
    // A US cup is 236.6ml, a metric cup 250ml, an imperial cup 284ml. A
    // confidently wrong number is worse than a caveated one.
    expect(toMetric(1, unit)?.approximate).toBe(true);
  });

  it("does not flag a unit that means the same everywhere", () => {
    expect(toMetric(100, "g")?.approximate).toBe(false);
    expect(toMetric(1, "kg")?.approximate).toBe(false);
    expect(toMetric(1, "tsp")?.approximate).toBe(false);
  });
});

describe("readability", () => {
  it("promotes to kg and l past a thousand, because 1500 g reads worse", () => {
    expect(toMetric(1500, "g")).toMatchObject({ qty: 1.5, unit: "kg" });
    expect(toMetric(2, "quart")).toMatchObject({ unit: "l" });
  });

  it("keeps small amounts precise and large ones whole", () => {
    expect(toMetric(1, "tsp")).toMatchObject({ qty: 4.9, unit: "ml" });
    expect(toMetric(1, "cup")).toMatchObject({ qty: 237, unit: "ml" });
  });

  it("is case and punctuation insensitive, as extracted units are messy", () => {
    expect(toMetric(1, "CUP")).not.toBeNull();
    expect(toMetric(1, " Tbsp. ")).not.toBeNull();
  });
});

describe("isMetric", () => {
  it("knows when there is nothing to offer", () => {
    expect(isMetric("g")).toBe(true);
    expect(isMetric("ml")).toBe(true);
    expect(isMetric("cup")).toBe(false);
    expect(isMetric("oz")).toBe(false);
    expect(isMetric(null)).toBe(false);
  });
});

describe("classifyUnit", () => {
  it("calls a missing unit vague, not count", () => {
    // The distinction matters: "vague" means the source never stated an amount,
    // "count" means it stated one in a unit that cannot be converted. Collapsing
    // them would lose the difference between "2 cloves" and "a handful".
    expect(classifyUnit(null)).toBe("vague");
  });

  it("classifies the units the tables know", () => {
    expect(classifyUnit("g")).toBe("mass");
    expect(classifyUnit("KG")).toBe("mass");
    expect(classifyUnit("cup")).toBe("volume");
    expect(classifyUnit("tsp")).toBe("volume");
  });

  it("falls through to count for anything it does not recognise", () => {
    // Countable, and also the honest answer for a unit nobody has added an
    // alias for yet — better a missing alias to fix than an invented factor.
    expect(classifyUnit("clove")).toBe("count");
    expect(classifyUnit("sprig")).toBe("count");
    expect(classifyUnit("no.")).toBe("count");
    expect(classifyUnit("wibble")).toBe("count");
  });
});
