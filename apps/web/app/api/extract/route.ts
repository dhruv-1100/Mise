import { NextResponse } from "next/server";

import { ExtractorError, extract } from "@/lib/extractor";

/** Every failure leaves this route in this shape — never a raw exception. */
interface ErrorEnvelope {
  error: string;
  detail: string;
}

const STATUS: Record<string, number> = {
  not_a_youtube_url: 400,
  video_not_found: 404,
  quota_exceeded: 429,
  queue_full: 429,
  unavailable: 503,
  llm_unavailable: 502,
  internal_error: 500,
};

export async function POST(request: Request): Promise<NextResponse> {
  let video: unknown;
  try {
    ({ video } = await request.json());
  } catch {
    return envelope("bad_request", "Body must be JSON.", 400);
  }

  if (typeof video !== "string" || video.trim().length === 0) {
    return envelope("bad_request", "Give a YouTube URL or video id.", 400);
  }
  if (video.length > 512) {
    // The extractor validates too; this just avoids paying an RPC to be told.
    return envelope("not_a_youtube_url", "That is too long to be a video link.", 400);
  }

  try {
    const { job, created } = await extract(video);
    return NextResponse.json({ job, created });
  } catch (error) {
    if (error instanceof ExtractorError) {
      const status = STATUS[error.code] ?? 500;
      // Backpressure carries an actionable hint rather than a bare refusal.
      return error.retryAfterSeconds === undefined
        ? envelope(error.code, error.message, status)
        : envelope(error.code, error.message, status, {
            "Retry-After": String(error.retryAfterSeconds),
          });
    }
    throw error;
  }
}

function envelope(
  error: string,
  detail: string,
  status: number,
  headers?: Record<string, string>,
): NextResponse {
  const init: ResponseInit = headers === undefined ? { status } : { status, headers };
  return NextResponse.json<ErrorEnvelope>({ error, detail }, init);
}
