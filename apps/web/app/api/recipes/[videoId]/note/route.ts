import { NextResponse } from "next/server";

import { getNote, setNote } from "@/lib/accounts";
import { envelope, jsonBody, parseVideoId, requireUser } from "@/lib/api";

type Params = { params: Promise<{ videoId: string }> };

/** Long enough for "used half the chilli, still too hot", short of an essay. */
const MAX_NOTE = 4000;

export async function GET(_request: Request, { params }: Params): Promise<NextResponse> {
  const caller = await requireUser();
  if (!caller.ok) return caller.response;
  const video = parseVideoId((await params).videoId);
  if (!video.ok) return video.response;

  return NextResponse.json({ note: await getNote(caller.value.userId, video.value) });
}

export async function PUT(request: Request, { params }: Params): Promise<NextResponse> {
  const caller = await requireUser();
  if (!caller.ok) return caller.response;
  const video = parseVideoId((await params).videoId);
  if (!video.ok) return video.response;

  const body = await jsonBody(request);
  if (!body.ok) return body.response;

  const note = (body.value as { note?: unknown }).note;
  if (typeof note !== "string") {
    return envelope("bad_request", "Expected { note: string }.", 400);
  }
  if (note.length > MAX_NOTE) {
    return envelope("note_too_long", `Notes are limited to ${MAX_NOTE} characters.`, 413);
  }

  await setNote(caller.value.userId, video.value, note);
  return NextResponse.json({ note: note.trim().length === 0 ? null : note.trim() });
}
