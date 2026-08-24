import "server-only";

import { Recipe } from "@mise/schema";

import { isConfigured, query, queryOne } from "@/lib/db";

/**
 * Creator corrections to an extraction.
 *
 * BUILD_PLAN.md §6.2: "Creators can claim their channel and edit extractions of
 * their own videos." An override is the creator's version of the recipe for one
 * video, and it wins over the extractor's output wherever it exists.
 *
 * What is stored is a Recipe — the structured extraction, which §1 of the plan
 * explicitly permits persisting. It is not, and must never become, the raw
 * description text the extraction came from.
 */

interface OverrideRow {
  recipe_json: unknown;
  updated_at: Date | string;
}

/**
 * Read a creator's version, if there is one.
 *
 * Returns null when the database is not configured, which is the same answer as
 * "no override exists" and keeps the public recipe page working on a deployment
 * with no accounts at all.
 *
 * The stored JSON is re-parsed through the contract on the way out rather than
 * trusted. It was valid when written, but the contract can change underneath a
 * row that has been sitting there for six months, and a page that renders a
 * recipe from a schema version it no longer understands is worse than one that
 * falls back to the extractor's output.
 */
export async function getOverride(videoId: string): Promise<Recipe | null> {
  if (!isConfigured) return null;

  const row = await queryOne<OverrideRow>(
    "SELECT recipe_json, updated_at FROM recipe_overrides WHERE video_id = $1",
    [videoId],
  );
  if (row === null) return null;

  const parsed = Recipe.safeParse(row.recipe_json);
  return parsed.success ? parsed.data : null;
}

/** Last write wins. Two edits to one video are two people who both own it. */
export async function putOverride(
  videoId: string,
  recipe: Recipe,
  editedBy: string,
): Promise<void> {
  await query(
    `INSERT INTO recipe_overrides (video_id, recipe_json, edited_by)
     VALUES ($1, $2, $3)
     ON CONFLICT (video_id)
     DO UPDATE SET recipe_json = EXCLUDED.recipe_json,
                   edited_by   = EXCLUDED.edited_by,
                   updated_at  = now()`,
    [videoId, JSON.stringify(recipe), editedBy],
  );
}

export async function deleteOverride(videoId: string): Promise<void> {
  await query("DELETE FROM recipe_overrides WHERE video_id = $1", [videoId]);
}
