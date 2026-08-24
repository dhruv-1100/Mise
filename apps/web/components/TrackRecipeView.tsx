"use client";

import { useEffect } from "react";

import { track } from "@/lib/analytics/client";

/**
 * Fires `recipe_viewed`, and renders nothing.
 *
 * The recipe page is a server component, and this event has to come from the
 * browser: it needs the visitor's distinct id, so that a view before signup and
 * a view after it belong to the same person. Firing it server-side would put it
 * on an anonymous id that nothing ever stitches.
 *
 * The counts travel with it because "did people open recipes that had no steps"
 * is the question the extractor's accuracy work actually gets judged on, and
 * joining back to the recipe later is not possible — nothing about a recipe is
 * stored on this side.
 */
export function TrackRecipeView({
  videoId,
  ingredientCount,
  stepCount,
}: {
  videoId: string;
  ingredientCount: number;
  stepCount: number;
}) {
  useEffect(() => {
    track({ name: "recipe_viewed", properties: { videoId, ingredientCount, stepCount } });
  }, [videoId, ingredientCount, stepCount]);

  return null;
}
