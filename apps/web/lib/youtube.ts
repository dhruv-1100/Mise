import "server-only";

/**
 * Channel ownership, proved rather than asserted.
 *
 * `channels.list?mine=true` answers exactly one question: which channel does
 * the person holding this OAuth token own? It is the only way to establish that
 * without taking someone's word for it, and it is the official YouTube Data API
 * v3, which CLAUDE.md requires and ADR 0001 explains.
 *
 * The access token is used once, here, and never stored. That is the same rule
 * the pipeline applies to transcripts — fetch, use, discard — and it applies
 * with more force to a credential. See docs/adr/0003-auth-and-sessions.md.
 */

export const YOUTUBE_READONLY_SCOPE = "https://www.googleapis.com/auth/youtube.readonly";

export interface OwnedChannel {
  channelId: string;
  title: string;
}

export type ChannelLookup =
  | { ok: true; channel: OwnedChannel }
  | { ok: false; reason: "no_channel" | "forbidden" | "unavailable" };

interface ChannelsListResponse {
  items?: { id?: string; snippet?: { title?: string } }[];
}

/** 1 quota unit. Cheap, unlike captions — see .env.example. */
export async function fetchOwnedChannel(accessToken: string): Promise<ChannelLookup> {
  let response: Response;
  try {
    response = await fetch(
      "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true",
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        cache: "no-store",
      },
    );
  } catch {
    return { ok: false, reason: "unavailable" };
  }

  // 401/403 here means the scope was not actually granted — Google's consent
  // screen lets a user tick some scopes and not others, so a successful sign-in
  // does not imply we got what we asked for.
  if (response.status === 401 || response.status === 403) {
    return { ok: false, reason: "forbidden" };
  }
  if (!response.ok) {
    return { ok: false, reason: "unavailable" };
  }

  const body = (await response.json()) as ChannelsListResponse;
  const item = body.items?.[0];
  // A Google account with no YouTube channel is a normal answer, not an error.
  if (item?.id === undefined || item.id.length === 0) {
    return { ok: false, reason: "no_channel" };
  }

  return {
    ok: true,
    channel: { channelId: item.id, title: item.snippet?.title ?? item.id },
  };
}
