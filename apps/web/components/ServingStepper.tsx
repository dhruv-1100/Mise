"use client";

import { scale, type ScaledIngredient } from "@mise/scaling";
import type { Recipe } from "@mise/schema";
import { useMemo, useState } from "react";

/**
 * The signature interaction (BUILD_PLAN.md §5.3).
 *
 * Runs the real engine — the same pure functions the property tests cover — so
 * salt grows sublinearly, countable things round to whole units, and a vague
 * quantity is never given a number.
 */
export function ServingStepper({ recipe }: { recipe: Recipe }) {
  const base = recipe.yield?.qty ?? null;
  const [servings, setServings] = useState(base ?? 4);

  const result = useMemo(() => scale(recipe, servings), [recipe, servings]);

  if (base === null) {
    // Scaling needs a yield to scale from. Saying so beats inventing four.
    return (
      <IngredientList
        items={recipe.ingredients.map((ingredient) => ({
          ingredient,
          originalQty: ingredient.qty,
          scalingClass: "LINEAR" as const,
          display: ingredient.qty === null ? (ingredient.qtyText ?? "") : String(ingredient.qty),
          warnings: [],
        }))}
        note="This video did not say how many it serves, so quantities are as written."
      />
    );
  }

  if (!result.ok) {
    return <IngredientList items={[]} note="These quantities cannot be scaled." />;
  }

  const { value } = result;

  return (
    <>
      <div className="flex items-center justify-between gap-3 rounded-lg border border-line bg-surface px-4 py-3.5">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.09em] text-ink-faint">
            Servings
          </p>
          <p className="text-[13px] text-ink-soft">
            {value.factor === 1
              ? "as written"
              : `scaled ${Math.round(value.factor * 100) / 100}× from ${base}`}
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            aria-label="Fewer servings"
            onClick={() => setServings((s) => Math.max(1, s - 1))}
            className="flex size-11 items-center justify-center rounded-md border border-line bg-ground text-xl"
          >
            −
          </button>
          {/* The number is the live region, not the whole list: announcing 22
              ingredients on every tap would be unusable. */}
          <output
            aria-live="polite"
            aria-label={`${servings} servings`}
            className="min-w-11 text-center text-2xl font-bold tabular-nums"
          >
            {servings}
          </output>
          <button
            type="button"
            aria-label="More servings"
            onClick={() => setServings((s) => Math.min(24, s + 1))}
            className="flex size-11 items-center justify-center rounded-md border border-line bg-ground text-xl"
          >
            +
          </button>
        </div>
      </div>

      {value.advisories.length > 0 && (
        <ul className="mt-3 flex flex-col gap-2">
          {value.advisories.map((a) => (
            /* Inline, never a modal — §5.3. */
            <li
              key={a.code}
              className="rounded-md bg-warn-wash px-3.5 py-2.5 text-[13px] leading-relaxed text-ink"
            >
              {a.message}
            </li>
          ))}
        </ul>
      )}

      <IngredientList items={value.ingredients} />
    </>
  );
}

function IngredientList({ items, note }: { items: ScaledIngredient[]; note?: string }) {
  return (
    <>
      {note !== undefined && <p className="mt-4 text-[13px] text-ink-soft">{note}</p>}
      <ul className="mt-6">
        {items.map((item, i) => (
          <li
            key={`${item.ingredient.name}-${i}`}
            className="flex items-baseline gap-3.5 border-b border-line py-2.5"
          >
            <span className="w-[88px] flex-none text-base font-semibold tabular-nums">
              {item.display}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-base leading-snug">{item.ingredient.name}</span>
              {item.ingredient.prep !== null && (
                <span className="mt-px block text-[13px] text-ink-faint">
                  {item.ingredient.prep}
                </span>
              )}
              {item.warnings
                .filter((w) => w.code === "ROUNDED_TO_WHOLE" || w.code === "SEASON_TO_TASTE")
                .map((w) => (
                  <span
                    key={w.code}
                    className="mt-1 block text-xs font-semibold text-warn-text"
                  >
                    {w.code === "ROUNDED_TO_WHOLE"
                      ? `rounded from ${w.exactQty}`
                      : "taste before adding more"}
                  </span>
                ))}
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}
