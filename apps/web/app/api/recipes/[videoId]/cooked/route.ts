import { NextResponse } from "next/server";

import { logCook } from "@/lib/accounts";
import { parseVideoId, requireUser } from "@/lib/api";

type Params = { params: Promise<{ videoId: string }> };

/**
 * Record that someone cooked this.
 *
 * Deliberately NOT idempotent — cooking the same recipe twice is two events,
 * and the count is the interesting product number (BUILD_PLAN.md §1: "saves per
 * user, cook-mode sessions"). Fired from the end of cook mode.
 */
export async function POST(_request: Request, { params }: Params): Promise<NextResponse> {
  const caller = await requireUser();
  if (!caller.ok) return caller.response;
  const video = parseVideoId((await params).videoId);
  if (!video.ok) return video.response;

  const cookedCount = await logCook(caller.value.userId, video.value);
  return NextResponse.json({ cookedCount });
}
