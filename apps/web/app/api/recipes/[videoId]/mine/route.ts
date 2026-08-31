import { NextResponse } from "next/server";
import { Recipe } from "@mise/schema";

import { envelope, jsonBody, parseVideoId, requireUser } from "@/lib/api";
import { getRecipe } from "@/lib/extractor";
import { deletePersonalRecipe, savePersonalRecipe } from "@/lib/personal";

type Params = { params: Promise<{ videoId: string }> };

/**
 * A reader's own version of a recipe.
 *
 * Deliberately NOT the same route as PUT /api/recipes/[videoId], which writes
 * the creator's correction and is authoritative for everyone. This one needs no
 * role and no claim — anyone signed in may edit their own copy — and the only
 * access control is the `user_id` on every statement in lib/personal.ts.
 *
 * Two things are still taken from the extractor rather than the request body,
 * for the same reason the creator route does it: attribution is not the
 * editor's to change, and a recipe is only editable if it exists.
 */

async function originalRecipe(videoId: string): Promise<Recipe | null> {
  const result = await getRecipe(videoId).catch(() => null);
  if (result === null || !result.found) return null;
  const parsed = Recipe.safeParse(JSON.parse(result.recipeJson));
  return parsed.success ? parsed.data : null;
}

export async function PUT(request: Request, { params }: Params): Promise<NextResponse> {
  const caller = await requireUser();
  if (!caller.ok) return caller.response;
  const video = parseVideoId((await params).videoId);
  if (!video.ok) return video.response;

  const body = await jsonBody(request);
  if (!body.ok) return body.response;

  const parsed = Recipe.safeParse(body.value);
  if (!parsed.success) {
    return envelope(
      "invalid_recipe",
      parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      422,
    );
  }

  // The video must exist as an extraction. Without this, this route would be a
  // general-purpose "store arbitrary JSON under a video id I invented" endpoint.
  const original = await originalRecipe(video.value);
  if (original === null) {
    return envelope("video_not_found", "There is no extraction for that video.", 404);
  }

  const recipe: Recipe = {
    ...parsed.data,
    // Not the editor's to change. Attribution is non-negotiable (CLAUDE.md) and
    // it feeds the page's JSON-LD, so it comes from the extractor every time
    // rather than from a body the caller wrote.
    videoId: video.value,
    creator: original.creator,
  };

  await savePersonalRecipe(caller.value.userId, video.value, recipe);
  return NextResponse.json({ ok: true, personal: true });
}

/** Revert to the creator's version, or the extractor's. */
export async function DELETE(_request: Request, { params }: Params): Promise<NextResponse> {
  const caller = await requireUser();
  if (!caller.ok) return caller.response;
  const video = parseVideoId((await params).videoId);
  if (!video.ok) return video.response;

  await deletePersonalRecipe(caller.value.userId, video.value);
  return NextResponse.json({ ok: true, personal: false });
}
