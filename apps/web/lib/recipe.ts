import "server-only";

import { Insufficient, type InsufficientReason, Recipe } from "@mise/schema";
import { getRecipe } from "@/lib/extractor";
import { getOverride } from "@/lib/overrides";
import { getPersonalRecipe } from "@/lib/personal";

/**
 * Why a recipe page has nothing to render.
 *
 * "There is no recipe" and "we know exactly why there is no recipe" are
 * different answers, and collapsing them into `null` is what turned a video
 * whose description is link-only into a bare 404 — after the progress screen
 * had already told the person their extraction succeeded.
 */
export type Extraction =
  /** `personal` marks a recipe the reader has edited, so the page can say so. */
  | { status: "ok"; recipe: Recipe; personal?: boolean }
  | { status: "insufficient"; videoId: string; reason: InsufficientReason }
  | { status: "missing" };

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
export async function loadExtraction(
  videoId: string,
  userId?: string | undefined,
): Promise<Extraction> {
  // Precedence, most specific first:
  //
  //   1. this reader's own edit    — "I use less chilli than he does"
  //   2. the creator's correction  — authoritative for everyone
  //   3. the extractor's output
  //
  // A personal edit wins over a creator's on purpose. The creator is right
  // about what their recipe is; the reader is right about what they want to
  // cook. Reverting a personal edit falls back through the same chain, so the
  // creator's version is never lost, only shadowed.
  if (userId !== undefined) {
    const mine = await getPersonalRecipe(userId, videoId).catch(() => null);
    if (mine !== null) return { status: "ok", recipe: mine.recipe, personal: true };
  }

  const override = await getOverride(videoId).catch(() => null);
  if (override !== null) return { status: "ok", recipe: override };

  const result = await getRecipe(videoId).catch(() => null);
  if (result === null || !result.found) return { status: "missing" };

  let raw: unknown;
  try {
    raw = JSON.parse(result.recipeJson);
  } catch {
    return { status: "missing" };
  }

  // Parsed through the shared contract rather than trusted. It crossed a
  // process boundary as JSON, and zod is what makes it a Recipe again here.
  const recipe = Recipe.safeParse(raw);
  if (recipe.success) return { status: "ok", recipe: recipe.data };

  // Not a recipe, but not nothing either: the extractor recorded why. ADR 0001
  // measured roughly one description in five carrying no usable recipe, so this
  // is a normal outcome the UI has to be able to say out loud.
  const insufficient = Insufficient.safeParse(raw);
  if (insufficient.success) {
    return {
      status: "insufficient",
      videoId: insufficient.data.videoId,
      reason: insufficient.data.reason,
    };
  }

  return { status: "missing" };
}

/**
 * For callers that only care whether there is a recipe to show.
 *
 * Cook mode, the editor and the saved list all either have a recipe or have
 * nothing to do; only the recipe page needs to explain itself.
 */
export async function loadRecipe(videoId: string): Promise<Recipe | null> {
  const extraction = await loadExtraction(videoId);
  return extraction.status === "ok" ? extraction.recipe : null;
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
