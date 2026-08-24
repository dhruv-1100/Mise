import { notFound } from "next/navigation";

import { auth, isAuthConfigured } from "@/auth";
import { CookMode } from "@/components/CookMode";
import { loadRecipe } from "@/lib/recipe";

export default async function CookPage({
  params,
}: {
  params: Promise<{ videoId: string }>;
}) {
  const { videoId } = await params;
  const recipe = await loadRecipe(videoId);
  if (recipe === null || recipe.steps.length === 0) notFound();

  // Signed out, cook mode works identically — it just has nowhere to record
  // that the cook happened. No wall, per BUILD_PLAN.md §6.1.
  const signedIn = isAuthConfigured && (await auth())?.user !== undefined;

  return <CookMode recipe={recipe} signedIn={signedIn} />;
}
