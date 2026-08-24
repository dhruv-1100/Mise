"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import type { Ingredient, Recipe, Step } from "@mise/schema";

/**
 * The creator's editor.
 *
 * Edits the same Recipe object the page renders and PUTs the whole thing back,
 * rather than sending a patch. The contract already has a validator on both
 * sides of the wire; a diff format would be a third representation with its own
 * bugs and no schema.
 *
 * Two rules from packages/schema are enforced here rather than being discovered
 * as a 422 after the fact, because both are easy to trip and neither is obvious
 * from the form:
 *
 *   - a unit without a quantity is meaningless, so clearing a quantity clears
 *     the unit with it
 *   - step indices must be contiguous from 1, so they are renumbered on submit
 *     rather than carried from whatever the extractor produced
 */
export function RecipeEditor({ recipe }: { recipe: Recipe }) {
  const router = useRouter();
  const [title, setTitle] = useState(recipe.title);
  const [servings, setServings] = useState(recipe.yield?.qty?.toString() ?? "");
  const [ingredients, setIngredients] = useState<Ingredient[]>(recipe.ingredients);
  const [steps, setSteps] = useState<Step[]>(recipe.steps);
  const [state, setState] = useState<"idle" | "saving" | "failed">("idle");
  const [error, setError] = useState<string | null>(null);

  function patchIngredient(index: number, patch: Partial<Ingredient>) {
    setIngredients((list) =>
      list.map((item, i) => (i === index ? { ...item, ...patch } : item)),
    );
  }

  function build(): Recipe {
    const yieldQty = servings.trim() === "" ? null : Number(servings);

    return {
      ...recipe,
      title: title.trim(),
      yield:
        yieldQty !== null && Number.isFinite(yieldQty) && yieldQty > 0
          ? { qty: yieldQty, qtyText: null, unit: recipe.yield?.unit ?? "serving" }
          : recipe.yield,
      ingredients: ingredients
        .filter((i) => i.name.trim().length > 0)
        .map((i) => ({
          ...i,
          name: i.name.trim(),
          // The schema refuses a unit with no quantity. Enforced here so the
          // creator gets an edit that behaves, not a validation error.
          unit: i.qty === null ? null : i.unit,
          prep: i.prep === null || i.prep.trim().length === 0 ? null : i.prep.trim(),
        })),
      steps: steps
        .filter((s) => s.text.trim().length > 0)
        .map((s, index) => ({ ...s, index: index + 1, text: s.text.trim() })),
      // A human touched this. The recipe has to say so, and the server forces
      // it too — this is the copy that keeps the request valid on the way in.
      sources: recipe.sources.includes("manual") ? recipe.sources : [...recipe.sources, "manual"],
    };
  }

  async function submit() {
    setState("saving");
    setError(null);

    try {
      const res = await fetch(`/api/recipes/${recipe.videoId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(build()),
      });

      if (!res.ok) {
        const body: unknown = await res.json().catch(() => null);
        const detail =
          typeof body === "object" && body !== null && "detail" in body
            ? String((body as { detail: unknown }).detail)
            : "Something went wrong.";
        setError(detail);
        setState("failed");
        return;
      }

      router.push(`/r/${recipe.videoId}`);
      router.refresh();
    } catch {
      setError("We could not reach the server.");
      setState("failed");
    }
  }

  async function revert() {
    setState("saving");
    await fetch(`/api/recipes/${recipe.videoId}`, { method: "DELETE" }).catch(() => null);
    router.push(`/r/${recipe.videoId}`);
    router.refresh();
  }

  return (
    <div className="mt-8">
      <Field label="Title">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="w-full rounded-md border border-line bg-surface px-3.5 py-3 text-base outline-none focus:border-accent"
        />
      </Field>

      <Field label="Serves">
        <input
          value={servings}
          onChange={(e) => setServings(e.target.value)}
          inputMode="numeric"
          placeholder="leave blank if the video does not say"
          className="w-full rounded-md border border-line bg-surface px-3.5 py-3 text-base outline-none placeholder:text-ink-faint focus:border-accent"
        />
      </Field>

      <h2 className="mt-8 text-xs font-semibold uppercase tracking-[0.09em] text-ink-faint">
        Ingredients
      </h2>
      <ul className="mt-2">
        {ingredients.map((ingredient, i) => (
          <li key={i} className="flex flex-wrap gap-2 border-b border-line py-2.5">
            <input
              aria-label={`Quantity for ingredient ${i + 1}`}
              value={ingredient.qty ?? ""}
              onChange={(e) => {
                const raw = e.target.value.trim();
                const qty = raw === "" ? null : Number(raw);
                patchIngredient(i, {
                  qty: qty !== null && Number.isFinite(qty) && qty > 0 ? qty : null,
                });
              }}
              inputMode="decimal"
              placeholder="qty"
              className="w-[68px] rounded-md border border-line bg-surface px-2.5 py-2 text-[15px] tabular-nums outline-none focus:border-accent"
            />
            <input
              aria-label={`Unit for ingredient ${i + 1}`}
              value={ingredient.unit ?? ""}
              onChange={(e) =>
                patchIngredient(i, {
                  unit: e.target.value.trim() === "" ? null : e.target.value,
                })
              }
              disabled={ingredient.qty === null}
              placeholder="unit"
              className="w-[76px] rounded-md border border-line bg-surface px-2.5 py-2 text-[15px] outline-none focus:border-accent disabled:opacity-50"
            />
            <input
              aria-label={`Name for ingredient ${i + 1}`}
              value={ingredient.name}
              onChange={(e) => patchIngredient(i, { name: e.target.value })}
              className="min-w-[140px] flex-1 rounded-md border border-line bg-surface px-2.5 py-2 text-[15px] outline-none focus:border-accent"
            />
            <button
              type="button"
              aria-label={`Remove ${ingredient.name || `ingredient ${i + 1}`}`}
              onClick={() => setIngredients((list) => list.filter((_, n) => n !== i))}
              className="size-11 flex-none rounded-md text-ink-faint"
            >
              ✕
            </button>
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={() =>
          setIngredients((list) => [
            ...list,
            {
              name: "",
              qty: null,
              qtyText: null,
              unit: null,
              prep: null,
              optional: false,
              // New lines came from a person, and the schema requires every
              // field-level source to be declared at recipe level — which is
              // why build() always adds "manual" to sources.
              source: "manual",
              confidence: 1,
            },
          ])
        }
        className="mt-3 flex h-11 items-center rounded-md border border-line px-4 text-[15px] font-semibold text-ink-soft"
      >
        Add ingredient
      </button>

      <h2 className="mt-8 text-xs font-semibold uppercase tracking-[0.09em] text-ink-faint">
        Method
      </h2>
      <ol className="mt-2">
        {steps.map((step, i) => (
          <li key={i} className="flex gap-3 border-b border-line py-2.5">
            <span className="mt-2 w-6 flex-none text-sm font-bold tabular-nums text-ink-faint">
              {i + 1}
            </span>
            <textarea
              aria-label={`Step ${i + 1}`}
              value={step.text}
              onChange={(e) =>
                setSteps((list) =>
                  list.map((s, n) => (n === i ? { ...s, text: e.target.value } : s)),
                )
              }
              rows={2}
              className="min-w-0 flex-1 resize-y rounded-md border border-line bg-surface px-2.5 py-2 text-[15px] leading-relaxed outline-none focus:border-accent"
            />
            <button
              type="button"
              aria-label={`Remove step ${i + 1}`}
              onClick={() => setSteps((list) => list.filter((_, n) => n !== i))}
              className="size-11 flex-none rounded-md text-ink-faint"
            >
              ✕
            </button>
          </li>
        ))}
      </ol>
      <button
        type="button"
        onClick={() =>
          setSteps((list) => [
            ...list,
            { index: list.length + 1, text: "", durationS: null, tempC: null, source: "manual" },
          ])
        }
        className="mt-3 flex h-11 items-center rounded-md border border-line px-4 text-[15px] font-semibold text-ink-soft"
      >
        Add step
      </button>

      {error !== null && (
        <p role="alert" className="mt-6 text-sm leading-relaxed text-warn-text">
          {error}
        </p>
      )}

      <div className="mt-8 flex flex-wrap gap-3 border-t border-line pt-6">
        <button
          type="button"
          onClick={() => void submit()}
          disabled={state === "saving"}
          className="flex h-11 items-center rounded-md bg-accent px-[18px] text-[15px] font-semibold text-ground disabled:opacity-60"
        >
          {state === "saving" ? "Saving…" : "Publish my version"}
        </button>
        <button
          type="button"
          onClick={() => void revert()}
          disabled={state === "saving"}
          className="flex h-11 items-center rounded-md px-4 text-[15px] text-ink-soft"
        >
          Revert to what Mise extracted
        </button>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="mt-5 block">
      <span className="text-xs font-semibold uppercase tracking-[0.09em] text-ink-faint">
        {label}
      </span>
      <span className="mt-2 block">{children}</span>
    </label>
  );
}
