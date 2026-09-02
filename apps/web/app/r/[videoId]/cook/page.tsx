import { notFound } from "next/navigation";

import { auth, isAuthConfigured } from "@/auth";
import { CookMode } from "@/components/CookMode";
import { loadRecipe } from "@/lib/recipe";

export default async function CookPage({
  params,
  searchParams,
}: {
  params: Promise<{ videoId: string }>;
  searchParams: Promise<{ servings?: string }>;
}) {
  const { videoId } = await params;
  const recipe = await loadRecipe(videoId);
  if (recipe === null || recipe.steps.length === 0) notFound();

  // Signed out, cook mode works identically — it just has nowhere to record
  // that the cook happened. No wall, per BUILD_PLAN.md §6.1.
  const signedIn = isAuthConfigured && (await auth())?.user !== undefined;

  // The serving count travels from the recipe page in the URL, because cook
  // mode is a separate route and the stepper's state cannot reach it otherwise.
  // Parsed defensively: this is a query parameter, so it is whatever anyone
  // types, and a bad value must fall back to the recipe's own yield rather than
  // scale by NaN.
  const raw = Number((await searchParams).servings);
  const servings =
    Number.isFinite(raw) && raw > 0 && raw <= 100 ? Math.floor(raw) : null;

  return <CookMode recipe={recipe} signedIn={signedIn} servings={servings} />;
}
