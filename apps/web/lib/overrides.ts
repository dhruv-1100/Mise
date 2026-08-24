import "server-only";

import { Creator, Recipe } from "@mise/schema";

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

export interface TrustedOwner {
  channelId: string;
  creator: Creator;
}

/**
 * Who this video belongs to, as recorded by us rather than by the caller.
 *
 * `channel_id` was written from the extractor's copy during an already
 * authorised edit, never from a request body — so reading it back is not the
 * self-authorising loop that reading `creator.channelId` out of the override
 * would be. See migration 0003 and ADR 0003.
 *
 * The creator block comes back with it, and this is the part that is easy to
 * get wrong: pinning only the id leaves `name` and `channelUrl` writable, and a
 * recipe whose visible byline and channel link say one thing while its id says
 * another is worse than either. Attribution is non-negotiable as a block, not
 * as a field.
 */
export async function getTrustedOwner(videoId: string): Promise<TrustedOwner | null> {
  if (!isConfigured) return null;
  const row = await queryOne<{ channel_id: string | null; creator: unknown }>(
    "SELECT channel_id, recipe_json->'creator' AS creator FROM recipe_overrides WHERE video_id = $1",
    [videoId],
  );
  if (row?.channel_id === null || row?.channel_id === undefined) return null;

  const creator = Creator.safeParse(row.creator);
  if (!creator.success) return null;
  return { channelId: row.channel_id, creator: creator.data };
}

/** Last write wins. Two edits to one video are two people who both own it. */
export async function putOverride(
  videoId: string,
  recipe: Recipe,
  editedBy: string,
  channelId: string,
): Promise<void> {
  await query(
    `INSERT INTO recipe_overrides (video_id, recipe_json, edited_by, channel_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (video_id)
     DO UPDATE SET recipe_json = EXCLUDED.recipe_json,
                   edited_by   = EXCLUDED.edited_by,
                   channel_id  = EXCLUDED.channel_id,
                   updated_at  = now()`,
    [videoId, JSON.stringify(recipe), editedBy, channelId],
  );
}

export async function deleteOverride(videoId: string): Promise<void> {
  await query("DELETE FROM recipe_overrides WHERE video_id = $1", [videoId]);
}
