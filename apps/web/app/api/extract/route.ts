import { NextResponse } from "next/server";

import { envelope, enveloped, jsonBody } from "@/lib/api";
import { extract } from "@/lib/extractor";

export const POST = enveloped(async (request: Request): Promise<NextResponse> => {
  const body = await jsonBody(request);
  if (!body.ok) return body.response;

  const video = (body.value as { video?: unknown } | null)?.video;
  if (typeof video !== "string" || video.trim().length === 0) {
    return envelope("bad_request", "Give a YouTube URL or video id.", 400);
  }
  if (video.length > 512) {
    // The extractor validates too; this just avoids paying an RPC to be told.
    return envelope("not_a_youtube_url", "That is too long to be a video link.", 400);
  }

  const { job, created } = await extract(video);
  return NextResponse.json({ job, created });
});
