import { NextResponse } from "next/server";
import { type Creator, Recipe } from "@mise/schema";

import { canEditChannel } from "@/lib/accounts";
import { envelope, enveloped, forbidden, jsonBody, parseVideoId, requireUser } from "@/lib/api";
import { deleteOverride, getTrustedOwner, putOverride } from "@/lib/overrides";
import { originalRecipe } from "@/lib/recipe";

type Params = { params: Promise<{ videoId: string }> };

interface Subject {
  channelId: string;
  /**
   * Attribution, from a source the caller does not control.
   *
   * Copied onto every saved override wholesale. Pinning only `channelId` and
   * letting `name` and `channelUrl` through would let an edit put someone
   * else's byline and channel link on the page — and into its JSON-LD — while
   * the id underneath still said otherwise.
   */
  creator: Creator;
}

/**
 * Resolve who this video belongs to, from a source the caller does not control.
 *
 * Two such sources, in order:
 *
 *   1. the extractor's current extraction, and
 *   2. `recipe_overrides.channel_id`, which the server wrote from (1) during an
 *      earlier authorised edit.
 *
 * The fallback exists because the extractor's cache expires. Without it, a
 * creator loses the ability to edit an override they already own, for a reason
 * that has nothing to do with whether they own it. Neither source is ever the
 * request body, and neither is `creator.channelId` inside the override — which
 * is the field the creator can write.
 */
async function subject(videoId: string): Promise<Subject | null> {
  const original = await originalRecipe(videoId);
  if (original !== null) {
    return { channelId: original.creator.channelId, creator: original.creator };
  }

  return await getTrustedOwner(videoId).catch(() => null);
}

/**
 * Replace an extraction with the creator's corrected version.
 *
 * The role on the session is not what authorises this. `canEditChannel` asks a
 * narrower question — does this specific person hold a verified claim on the
 * channel this specific video belongs to — and that is the only question whose
 * answer is safe to act on.
 */
export const PUT = enveloped(async (request: Request, { params }: Params): Promise<NextResponse> => {
  const caller = await requireUser();
  if (!caller.ok) return caller.response;
  const video = parseVideoId((await params).videoId);
  if (!video.ok) return video.response;

  const owner = await subject(video.value);
  if (owner === null) {
    return envelope("video_not_found", "There is no extraction for that video.", 404);
  }
  if (!(await canEditChannel(caller.value.userId, owner.channelId))) {
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

  // Attribution is non-negotiable (CLAUDE.md), so none of it is editable. The
  // whole creator block is replaced with the trusted one — the extractor's if
  // it still has the video, otherwise the one already stored on the override.
  // Whatever the request said about the creator is discarded.
  //
  // "manual" is forced into sources for the same reason in the other direction:
  // a human touched this, and the recipe must say so. Provenance a creator can
  // quietly remove is provenance worth nothing.
  const recipe: Recipe = {
    ...parsed.data,
    creator: owner.creator,
    sources: parsed.data.sources.includes("manual")
      ? parsed.data.sources
      : [...parsed.data.sources, "manual"],
  };

  await putOverride(video.value, recipe, caller.value.userId, owner.channelId);
  return NextResponse.json({ recipe });
});

/** Revert to the extractor's version. */
export const DELETE = enveloped(async (_request: Request, { params }: Params): Promise<NextResponse> => {
  const caller = await requireUser();
  if (!caller.ok) return caller.response;
  const video = parseVideoId((await params).videoId);
  if (!video.ok) return video.response;

  const owner = await subject(video.value);
  if (owner === null) {
    return envelope("video_not_found", "There is no extraction for that video.", 404);
  }
  if (!(await canEditChannel(caller.value.userId, owner.channelId))) {
    return forbidden("You can only edit videos from a channel you have claimed.");
  }

  await deleteOverride(video.value);
  return NextResponse.json({ reverted: true });
});
