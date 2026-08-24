import { NextResponse } from "next/server";
import { Recipe } from "@mise/schema";

import { canEditChannel } from "@/lib/accounts";
import { envelope, forbidden, jsonBody, parseVideoId, requireUser } from "@/lib/api";
import { getRecipe } from "@/lib/extractor";
import { deleteOverride, putOverride } from "@/lib/overrides";

type Params = { params: Promise<{ videoId: string }> };

/**
 * The extractor's own version of a recipe, ignoring any override.
 *
 * Authorisation must be decided against this and never against the override.
 * An override is a document the creator controls; if the ownership check read
 * `creator.channelId` out of it, the first edit could rewrite that field to a
 * channel the editor owns and the second edit would authorise itself. Reading
 * the upstream extraction every time closes that loop.
 */
async function originalRecipe(videoId: string): Promise<Recipe | null> {
  const result = await getRecipe(videoId).catch(() => null);
  if (result === null || !result.found) return null;
  const parsed = Recipe.safeParse(JSON.parse(result.recipeJson));
  return parsed.success ? parsed.data : null;
}

/**
 * Replace an extraction with the creator's corrected version.
 *
 * The role on the session is not what authorises this. `canEditChannel` asks a
 * narrower question — does this specific person hold a verified claim on the
 * channel this specific video belongs to — and that is the only question whose
 * answer is safe to act on.
 */
export async function PUT(request: Request, { params }: Params): Promise<NextResponse> {
  const caller = await requireUser();
  if (!caller.ok) return caller.response;
  const video = parseVideoId((await params).videoId);
  if (!video.ok) return video.response;

  const original = await originalRecipe(video.value);
  if (original === null) {
    return envelope("video_not_found", "There is no extraction for that video.", 404);
  }
  if (!(await canEditChannel(caller.value.userId, original.creator.channelId))) {
    return forbidden("You can only edit videos from a channel you have claimed.");
  }

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
  if (parsed.data.videoId !== video.value) {
    return envelope("bad_request", "Recipe videoId does not match the URL.", 400);
  }

  // Attribution is non-negotiable (CLAUDE.md), so it is not editable. Taking
  // the creator block from the extraction rather than from the request means an
  // edit cannot rewrite whose video this is, even by accident.
  //
  // "manual" is forced into sources for the same reason in the other direction:
  // a human touched this, and the recipe must say so. Provenance that a creator
  // could quietly remove is provenance worth nothing.
  const recipe: Recipe = {
    ...parsed.data,
    creator: original.creator,
    sources: parsed.data.sources.includes("manual")
      ? parsed.data.sources
      : [...parsed.data.sources, "manual"],
  };

  await putOverride(video.value, recipe, caller.value.userId);
  return NextResponse.json({ recipe });
}

/** Revert to the extractor's version. */
export async function DELETE(_request: Request, { params }: Params): Promise<NextResponse> {
  const caller = await requireUser();
  if (!caller.ok) return caller.response;
  const video = parseVideoId((await params).videoId);
  if (!video.ok) return video.response;

  const original = await originalRecipe(video.value);
  if (original === null) {
    return envelope("video_not_found", "There is no extraction for that video.", 404);
  }
  if (!(await canEditChannel(caller.value.userId, original.creator.channelId))) {
    return forbidden("You can only edit videos from a channel you have claimed.");
  }

  await deleteOverride(video.value);
  return NextResponse.json({ reverted: true });
}
