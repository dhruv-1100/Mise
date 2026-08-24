import "server-only";

import { NextResponse } from "next/server";
import { VideoId } from "@mise/schema";

import { auth } from "@/auth";
import type { Role } from "@/lib/accounts";

/**
 * The shared shape of every API response in this app.
 *
 * CLAUDE.md: "Every API route returns a typed error envelope, never a raw
 * exception." That was one route's private helper until this phase added five
 * more; a convention copied six times is a convention about to be broken.
 */
export interface ErrorEnvelope {
  error: string;
  detail: string;
}

export function envelope(
  error: string,
  detail: string,
  status: number,
  headers?: Record<string, string>,
): NextResponse {
  const init: ResponseInit = headers === undefined ? { status } : { status, headers };
  return NextResponse.json<ErrorEnvelope>({ error, detail }, init);
}

export const unauthorized = () =>
  envelope("unauthenticated", "Sign in to do that.", 401);

export const forbidden = (detail: string) => envelope("forbidden", detail, 403);

export type Guard<T> = { ok: true; value: T } | { ok: false; response: NextResponse };

export interface Caller {
  userId: string;
  role: Role;
}

/**
 * The signed-in caller, or a 401.
 *
 * Returns a discriminated result rather than throwing, so a route's happy path
 * and its refusal are both visible in the same function and neither can be
 * forgotten. The role here comes off the session and is only ever used for
 * cheap gating — anything that authorises a write re-reads it, or better,
 * checks ownership. See lib/accounts.ts.
 */
export async function requireUser(): Promise<Guard<Caller>> {
  const user = (await auth())?.user;
  if (user === undefined || user.id === undefined) {
    return { ok: false, response: unauthorized() };
  }
  return { ok: true, value: { userId: user.id, role: user.role } };
}

/**
 * Validate a video id from the URL.
 *
 * The same 11-character rule as packages/schema and as the database domain in
 * migration 0002. Three layers stating one rule is not duplication here: the
 * route rejects junk before it costs a query, and the domain catches anything
 * that ever reaches the database by another path.
 */
export function parseVideoId(raw: string): Guard<string> {
  const parsed = VideoId.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, response: envelope("bad_request", "Not a YouTube video id.", 400) };
  }
  return { ok: true, value: parsed.data };
}

/** JSON body, or a 400. Never a raw parse exception escaping to the client. */
export async function jsonBody(request: Request): Promise<Guard<unknown>> {
  try {
    return { ok: true, value: await request.json() };
  } catch {
    return { ok: false, response: envelope("bad_request", "Body must be JSON.", 400) };
  }
}
