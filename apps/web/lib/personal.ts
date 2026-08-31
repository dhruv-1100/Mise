import "server-only";

import { Recipe } from "@mise/schema";
import { query, queryOne, isConfigured } from "@/lib/db";

/**
 * A person's own version of a recipe.
 *
 * NOT the same thing as `lib/overrides.ts`, and the difference is the one worth
 * keeping straight:
 *
 *   overrides.ts   the creator's correction. One per video, written only by
 *                  someone who proved they own the channel, and authoritative
 *                  for every reader.
 *   personal.ts    "I use less chilli than he does". One per person per video,
 *                  written by anyone signed in, visible only to its author.
 *
 * Every statement here carries `user_id` in its WHERE clause, without exception.
 * That is the entire access control for this table — there is no role check,
 * because there is no version of this where one person may read another's.
 */

export interface PersonalRecipe {
  recipe: Recipe;
  updatedAt: Date;
}

/**
 * Null when the database is not configured, so a deployment without accounts
 * keeps serving the public recipe pages rather than failing on every render.
 */
export async function getPersonalRecipe(
  userId: string,
  videoId: string,
): Promise<PersonalRecipe | null> {
  if (!isConfigured) return null;

  const row = await queryOne<{ recipe_json: unknown; updated_at: string | Date }>(
    "SELECT recipe_json, updated_at FROM personal_recipes WHERE user_id = $1 AND video_id = $2",
    [userId, videoId],
  );
  if (row === null) return null;

  // Parsed, not trusted. This row was written by a request body; a schema change
  // that invalidates an old edit must degrade to "no personal version" rather
  // than crash the recipe page.
  const parsed = Recipe.safeParse(row.recipe_json);
  if (!parsed.success) return null;

  return { recipe: parsed.data, updatedAt: new Date(row.updated_at) };
}

export async function savePersonalRecipe(
  userId: string,
  videoId: string,
  recipe: Recipe,
): Promise<void> {
  await query(
    `INSERT INTO personal_recipes (user_id, video_id, recipe_json)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, video_id)
     DO UPDATE SET recipe_json = EXCLUDED.recipe_json, updated_at = now()`,
    [userId, videoId, JSON.stringify(recipe)],
  );
}

/** Revert to whatever the extractor and the creator say. */
export async function deletePersonalRecipe(userId: string, videoId: string): Promise<void> {
  await query("DELETE FROM personal_recipes WHERE user_id = $1 AND video_id = $2", [
    userId,
    videoId,
  ]);
}
