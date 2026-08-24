import "server-only";

import { Recipe } from "@mise/schema";
import { getRecipe } from "@/lib/extractor";
import { getOverride } from "@/lib/overrides";

/**
 * Fetch a recipe by video id.
 *
 * The extractor caches by video, so this is a cache read for anything already
 * extracted. Parsed through the shared contract rather than trusted: the
 * recipe crossed a process boundary as JSON, and zod is what makes it a Recipe
 * again on this side.
 *
 * A verified creator's correction wins over the extractor's output. Checked
 * first rather than merged afterwards: the creator's version is a whole recipe,
 * not a patch, so there is nothing to merge and no order-of-application
 * question to get wrong. `getOverride` returns null when the database is not
 * configured, so this path is unchanged on a deployment with no accounts.
 */
export async function loadRecipe(videoId: string): Promise<Recipe | null> {
  const override = await getOverride(videoId).catch(() => null);
  if (override !== null) return override;

  const result = await getRecipe(videoId).catch(() => null);
  if (result === null || !result.found) return null;

  // Parsed through the shared contract rather than trusted. It crossed a
  // process boundary as JSON, and zod is what makes it a Recipe again here.
  // An extraction that produced insufficient_source_material lands here too
  // and fails this parse, which is the correct outcome: there is no recipe.
  const parsed = Recipe.safeParse(JSON.parse(result.recipeJson));
  return parsed.success ? parsed.data : null;
}

/**
 * Recipe JSON-LD.
 *
 * BUILD_PLAN.md §6.1 calls this the main organic acquisition channel: recipe
 * schema is one of the few types Google renders as a rich result, and it costs
 * nothing. Emitted from the same object the page renders, so the two cannot
 * disagree — structured data that contradicts the visible page is worse than
 * none, because it is what gets penalised.
 */
export function toJsonLd(recipe: Recipe, url: string): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "Recipe",
    name: recipe.title,
    url,
    author: {
      "@type": "Person",
      name: recipe.creator.name,
      url: recipe.creator.channelUrl,
    },
    // Attribution is non-negotiable (CLAUDE.md): the video is the source and
    // the page is a companion to it.
    video: {
      "@type": "VideoObject",
      name: recipe.title,
      embedUrl: `https://www.youtube.com/embed/${recipe.videoId}`,
    },
    recipeYield:
      recipe.yield === null
        ? undefined
        : `${recipe.yield.qty ?? recipe.yield.qtyText} ${recipe.yield.unit}`,
    recipeIngredient: recipe.ingredients.map((i) => {
      const amount = i.qty === null ? (i.qtyText ?? "") : `${i.qty}${i.unit ? ` ${i.unit}` : ""}`;
      return [amount, i.name, i.prep].filter(Boolean).join(" ").trim();
    }),
    recipeInstructions: recipe.steps.map((s) => ({
      "@type": "HowToStep",
      position: s.index,
      text: s.text,
    })),
    tool: recipe.equipment.length > 0 ? recipe.equipment : undefined,
  };
}
