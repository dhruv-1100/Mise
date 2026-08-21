/**
 * Unit display intelligence.
 *
 * "0.33 cups should render as 1/3 cup, not 0.33 cup." Nobody measures 0.33 of
 * anything, and a recipe that asks them to reads as broken.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { formatQuantity } from "../src/index";

describe("formatQuantity", () => {
  it.each([
    [1, "cup", "1 cup"],
    [2, "tbsp", "2 tbsp"],
    [0.5, "cup", "½ cup"],
    [0.25, "tsp", "¼ tsp"],
    [0.75, "cup", "¾ cup"],
    [1.5, "cup", "1½ cup"],
    [2.25, "cup", "2¼ cup"],
    [0.125, "tsp", "⅛ tsp"],
    [3, "clove", "3 clove"],
  ])("renders %s %s as %s", (qty, unit, expected) => {
    expect(formatQuantity(qty, unit)).toBe(expected);
  });

  it("renders a third as a fraction, not a decimal", () => {
    expect(formatQuantity(1 / 3, "cup")).toBe("⅓ cup");
    expect(formatQuantity(2 / 3, "cup")).toBe("⅔ cup");
  });

  it("snaps a near-third to a third", () => {
    // Scaling arithmetic produces 0.3333333333333333, not 1/3 exactly.
    expect(formatQuantity(0.333333, "cup")).toBe("⅓ cup");
    expect(formatQuantity(0.33, "cup")).toBe("⅓ cup");
  });

  it("decomposes an awkward tablespoon amount into spoons", () => {
    // The plan's example: 1.5 tbsp is clearer as 1 tbsp + 1½ tsp.
    expect(formatQuantity(1.5, "tbsp")).toBe("1 tbsp + 1½ tsp");
  });

  it("leaves a clean tablespoon amount alone", () => {
    expect(formatQuantity(2, "tbsp")).toBe("2 tbsp");
  });

  it("renders weights as decimals, because scales do", () => {
    // Fractions exist here because measuring cups and spoons carry fraction
    // markings. A digital scale does not, so "1⅔ kg" would be asking the cook
    // to read something their equipment cannot show.
    expect(formatQuantity(333.333333, "g")).toBe("333 g");
    expect(formatQuantity(1.6666, "kg")).toBe("1.67 kg");
    expect(formatQuantity(1.75, "kg")).toBe("1.75 kg");
    expect(formatQuantity(2, "kg")).toBe("2 kg");
    expect(formatQuantity(1.5, "l")).toBe("1.5 l");
  });

  it("keeps grams legible below ten", () => {
    expect(formatQuantity(4.5, "g")).toBe("4.5 g");
    expect(formatQuantity(0.004, "g")).toBe("0.004 g");
  });

  it("handles a missing unit", () => {
    expect(formatQuantity(3, null)).toBe("3");
    expect(formatQuantity(1.5, null)).toBe("1½");
  });

  it("renders nothing for a vague quantity", () => {
    // The caller substitutes the source's own wording ("to taste").
    expect(formatQuantity(null, "tsp")).toBe("");
    expect(formatQuantity(null, null)).toBe("");
  });

  it("decomposes a tablespoon with no whole part into teaspoons alone", () => {
    expect(formatQuantity(0.5, "tbsp")).toBe("1½ tsp");
  });

  it("never emits a bare decimal for a common fraction", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(0.125, 0.25, 1 / 3, 0.375, 0.5, 0.625, 2 / 3, 0.75, 0.875),
        fc.integer({ min: 0, max: 9 }),
        (fraction, whole) => {
          const rendered = formatQuantity(whole + fraction, "cup");
          expect(rendered).not.toMatch(/\d\.\d/);
          return true;
        },
      ),
      { numRuns: 200 },
    );
  });

  it("never renders an empty amount for a positive quantity", () => {
    fc.assert(
      fc.property(fc.double({ min: 0.001, max: 10000, noNaN: true }), (qty) => {
        const rendered = formatQuantity(qty, "g");
        expect(rendered.trim().length).toBeGreaterThan(0);
        expect(rendered).not.toMatch(/^0 /);
        return true;
      }),
      { numRuns: 500 },
    );
  });
});
