import { NextResponse } from "next/server";

import { isSaved, save, unsave } from "@/lib/accounts";
import { parseVideoId, requireUser } from "@/lib/api";

type Params = { params: Promise<{ videoId: string }> };

/** Idempotent: POSTing twice leaves one save and reports the same state. */
export async function POST(_request: Request, { params }: Params): Promise<NextResponse> {
  const caller = await requireUser();
  if (!caller.ok) return caller.response;
  const video = parseVideoId((await params).videoId);
  if (!video.ok) return video.response;

  await save(caller.value.userId, video.value);
  return NextResponse.json({ saved: true });
}

export async function DELETE(_request: Request, { params }: Params): Promise<NextResponse> {
  const caller = await requireUser();
  if (!caller.ok) return caller.response;
  const video = parseVideoId((await params).videoId);
  if (!video.ok) return video.response;

  await unsave(caller.value.userId, video.value);
  return NextResponse.json({ saved: false });
}

export async function GET(_request: Request, { params }: Params): Promise<NextResponse> {
  const caller = await requireUser();
  if (!caller.ok) return caller.response;
  const video = parseVideoId((await params).videoId);
  if (!video.ok) return video.response;

  return NextResponse.json({ saved: await isSaved(caller.value.userId, video.value) });
}
