"use client";

import type { ScaledIngredient } from "@mise/scaling";
import { useState } from "react";

/**
 * What this step needs, on the step itself.
 *
 * Cook mode used to show only the instruction, so anyone who could not remember
 * how much cumin the recipe called for had to leave cook mode, find the line,
 * and come back — with wet hands, at a hob. The card is the fix.
 *
 * Deliberately larger than the recipe page: amounts 19px, names 18px. This is
 * read from across a counter rather than held at arm's length, and the amount
 * column is fixed at 104px with tabular figures so the numbers align down the
 * card instead of wandering with the text.
 */
export function StepIngredients({
  items,
  all,
  servings,
  /**
   * Whether `items` is genuinely this step's ingredients or the whole list.
   *
   * The spec calls for `step.uses` in the schema, populated during extraction.
   * It is not there yet and is deliberately not added here — see the note in
   * CookMode — so today every step gets the full list. Saying "You need for
   * this step" over a list that is not this step's would be a small lie told
   * at a hob, which is the worst place to tell one.
   */
  precise,
}: {
  /** Ingredients this step uses. Empty renders nothing at all. */
  items: ScaledIngredient[];
  /** The whole list, for the expander. */
  all: ScaledIngredient[];
  servings: number | null;
  precise: boolean;
}) {
  const [expanded, setExpanded] = useState(false);

  // No empty state and no placeholder. A step that uses nothing — "cover and
  // rest for 20 minutes" — should show the instruction and nothing else.
  if (items.length === 0) return null;

  const showing = expanded ? all : items;
  const canExpand = precise && all.length > items.length;

  return (
    <div className="mt-7 rounded-lg bg-cook-surface px-5 pb-2 pt-[18px]">
      <div className="flex items-baseline justify-between gap-3 pb-3">
        <span className="text-xs font-semibold uppercase tracking-[0.09em] text-cook-ink-soft">
          {!precise ? "Ingredients" : expanded ? "All ingredients" : "You need for this step"}
        </span>
        {servings !== null && (
          <span className="text-xs font-semibold tabular-nums text-cook-ink-soft">
            {servings} servings
          </span>
        )}
      </div>

      <ul>
        {showing.map((item, i) => (
          <li
            key={`${item.ingredient.name}-${i}`}
            className="flex items-baseline gap-4 border-t border-cook-ink/10 py-[11px]"
          >
            <span className="w-[104px] flex-none text-[19px] font-bold tabular-nums">
              {item.display}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[18px] leading-tight">{item.ingredient.name}</span>
              {item.ingredient.prep !== null && (
                <span className="mt-0.5 block text-sm text-cook-ink-soft">
                  {item.ingredient.prep}
                </span>
              )}
            </span>
          </li>
        ))}
      </ul>

      {canExpand && (
        /* Expands in place rather than navigating. Losing your step to look up
           a quantity is the problem this card exists to solve, and a link back
           to the recipe page would reintroduce it. */
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          aria-expanded={expanded}
          className="min-h-11 w-full border-t border-cook-ink/10 pb-2.5 pt-3 text-left text-sm font-semibold text-cook-ink-soft"
        >
          {expanded ? "Just this step" : "All ingredients"}
        </button>
      )}
    </div>
  );
}
