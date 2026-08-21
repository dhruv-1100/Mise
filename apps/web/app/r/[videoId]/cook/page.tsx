import { notFound } from "next/navigation";

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

  return <CookMode recipe={recipe} />;
}
