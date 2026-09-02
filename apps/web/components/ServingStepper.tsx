"use client";

import Link from "next/link";

import { isMetric, scale, toMetric, type ScaledIngredient } from "@mise/scaling";
import type { Recipe } from "@mise/schema";
import { useEffect, useMemo, useRef, useState } from "react";

import { track } from "@/lib/analytics/client";

/**
 * The signature interaction (BUILD_PLAN.md §5.3).
 *
 * Runs the real engine — the same pure functions the property tests cover — so
 * salt grows sublinearly, countable things round to whole units, and a vague
 * quantity is never given a number.
 */
const METRIC_KEY = "mise:metric";

export function ServingStepper({ recipe }: { recipe: Recipe }) {
  const base = recipe.yield?.qty ?? null;
  const [servings, setServings] = useState(base ?? 4);
  const [metric, setMetric] = useState(false);

  // Read after mount, never during render: the server has no localStorage, and
  // seeding state from it directly would make the first client render disagree
  // with the server's HTML. Wrapped because a private window or a browser set
  // to block site data throws on access rather than returning null.
  useEffect(() => {
    try {
      setMetric(window.localStorage.getItem(METRIC_KEY) === "1");
    } catch {
      // No storage. The toggle still works, it just does not persist.
    }
  }, []);

  function chooseMetric(next: boolean) {
    setMetric(next);
    try {
      window.localStorage.setItem(METRIC_KEY, next ? "1" : "0");
    } catch {
      // As above.
    }
  }

  // Offering the toggle when it would change nothing is worse than not
  // offering it: the reader taps it and wonders what broke. Only shown when
  // something here is convertible AND not already metric.
  const convertible = recipe.ingredients.some(
    (i) => !isMetric(i.unit) && toMetric(i.qty, i.unit) !== null,
  );

  const result = useMemo(() => scale(recipe, servings), [recipe, servings]);

  /**
   * Report where the stepper came to rest, not every tap on the way.
   *
   * Going from 4 to 12 is eight taps and one decision. Firing per tap would
   * make the median "servings_changed" a delta of one and bury the thing worth
   * knowing — how far people actually scale, which is the question this whole
   * package exists to answer.
   */
  const settled = useRef(base ?? 4);
  useEffect(() => {
    if (base === null || servings === settled.current) return;
    const timer = setTimeout(() => {
      track({
        name: "servings_changed",
        properties: {
          videoId: recipe.videoId,
          from: settled.current,
          to: servings,
          factor: Math.round((servings / base) * 1000) / 1000,
        },
      });
      settled.current = servings;
    }, 800);
    return () => clearTimeout(timer);
  }, [servings, base, recipe.videoId]);

  if (base === null) {
    // Scaling needs a yield to scale from. Saying so beats inventing four.
    return (
      <IngredientList
        metric={false}
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
    return <IngredientList items={[]} metric={false} note="These quantities cannot be scaled." />;
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

      {convertible && (
        <div className="mt-6 flex items-center justify-end gap-2">
          <span className="text-[13px] text-ink-faint">Units</span>
          <div
            role="group"
            aria-label="Unit system"
            className="flex overflow-hidden rounded-md border border-line"
          >
            <button
              type="button"
              aria-pressed={!metric}
              onClick={() => chooseMetric(false)}
              className={`min-h-11 px-3.5 text-[13px] font-semibold ${
                metric ? "text-ink-soft" : "bg-accent-wash text-accent-deep"
              }`}
            >
              As written
            </button>
            <button
              type="button"
              aria-pressed={metric}
              onClick={() => chooseMetric(true)}
              className={`min-h-11 border-l border-line px-3.5 text-[13px] font-semibold ${
                metric ? "bg-accent-wash text-accent-deep" : "text-ink-soft"
              }`}
            >
              Metric
            </button>
          </div>
        </div>
      )}

      <IngredientList items={value.ingredients} metric={metric} />

      {recipe.steps.length > 0 && (
        /* The link lives here rather than on the page because it has to carry
           the serving count, and this component is where that count lives.
           Cook mode is a separate route, so a query parameter is the only way
           across — and it survives a reload and a shared link, which lifting
           the state into a context would not. */
        <Link
          href={`/r/${recipe.videoId}/cook?servings=${servings}`}
          className="mt-7 flex min-h-11 items-center justify-center gap-2.5 rounded-md bg-accent px-4 py-3.5 text-base font-semibold text-ground"
        >
          Start cooking
        </Link>
      )}
    </>
  );
}

function IngredientList({
  items,
  metric,
  note,
}: {
  items: ScaledIngredient[];
  metric: boolean;
  note?: string;
}) {
  return (
    <>
      {note !== undefined && <p className="mt-4 text-[13px] text-ink-soft">{note}</p>}
      <ul className="mt-6">
        {items.map((item, i) => (
          <li
            key={`${item.ingredient.name}-${i}`}
            className="flex items-baseline gap-3.5 border-b border-line py-2.5"
          >
            <Amount item={item} metric={metric} />
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

/**
 * The amount, in whichever system the reader chose.
 *
 * Conversion happens here rather than inside `scale()`. The scaling engine is
 * pure and deterministic by charter and has no business knowing about a
 * display preference; and the same scaled recipe has to be renderable both
 * ways without recomputing it.
 *
 * Falls back to the written amount whenever there is nothing to convert — a
 * count ("2 no."), a vague quantity ("to taste"), or a unit the tables do not
 * know. Silently showing the original is right: the reader asked for metric
 * where metric exists, not for every line to change.
 */
function Amount({ item, metric }: { item: ScaledIngredient; metric: boolean }) {
  const converted = metric ? toMetric(item.ingredient.qty, item.ingredient.unit) : null;

  if (converted === null) {
    return (
      <span className="w-[88px] flex-none text-base font-semibold tabular-nums">
        {item.display}
      </span>
    );
  }

  return (
    <span className="w-[88px] flex-none text-base font-semibold tabular-nums">
      {converted.qty} {converted.unit}
      {/* A US cup is 236.6ml, a metric cup 250ml, an imperial cup 284ml — up to
          20% apart. The reader is told rather than handed a confident number
          that may be a fifth wrong. */}
      {converted.approximate && (
        <span
          className="ml-1 text-[11px] font-semibold text-ink-faint"
          title={`Converted from ${item.display}. Cup and tablespoon sizes differ by region; this assumes US measures.`}
        >
          ≈
        </span>
      )}
    </span>
  );
}
