import "server-only";

import { query, queryOne } from "@/lib/db";

/**
 * Every query that touches a signed-in person's data.
 *
 * Kept in one file on purpose: the interesting security property of this phase
 * is that a user can only ever read or write their own rows, and that is much
 * easier to audit when every WHERE clause is on one screen. Every function here
 * takes `userId` as its first argument and every statement constrains on it.
 */

export const ROLES = ["user", "creator", "admin"] as const;
export type Role = (typeof ROLES)[number];

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Users and roles
// ---------------------------------------------------------------------------

/**
 * Read a role straight from the database.
 *
 * The JWT carries a copy for cheap UI decisions, but a copy can be stale — a
 * claim made five minutes ago promoted the row and not the cookie. Anything
 * that authorises a write reads through here.
 */
export async function getRole(userId: string): Promise<Role> {
  const row = await queryOne<{ role: string }>("SELECT role FROM users WHERE id = $1", [userId]);
  return row !== null && isRole(row.role) ? row.role : "user";
}

/**
 * Promote a user, never demote.
 *
 * The `AND role = 'user'` is the whole point: an admin who happens to claim a
 * channel must not be quietly reduced to a creator by their own claim.
 */
export async function promoteToCreator(userId: string): Promise<void> {
  await query("UPDATE users SET role = 'creator' WHERE id = $1 AND role = 'user'", [userId]);
}

// ---------------------------------------------------------------------------
// Creator claims
// ---------------------------------------------------------------------------

export interface CreatorClaim {
  channelId: string;
  channelTitle: string;
  verifiedAt: string;
}

export async function listClaims(userId: string): Promise<CreatorClaim[]> {
  const { rows } = await query<{
    channel_id: string;
    channel_title: string;
    verified_at: Date | string;
  }>(
    `SELECT channel_id, channel_title, verified_at
       FROM creator_claims WHERE user_id = $1 ORDER BY verified_at DESC`,
    [userId],
  );
  return rows.map((r) => ({
    channelId: r.channel_id,
    channelTitle: r.channel_title,
    verifiedAt: new Date(r.verified_at).toISOString(),
  }));
}

export type ClaimOutcome = "claimed" | "already_yours" | "taken_by_another";

/**
 * Record a verified claim.
 *
 * The channel_id UNIQUE constraint does the real work: two people cannot hold
 * one channel, and the race between two simultaneous claims is settled by
 * Postgres rather than by a check-then-insert that would lose it. ON CONFLICT
 * DO NOTHING plus a follow-up read tells us which of the three outcomes
 * happened without ever trusting a prior SELECT.
 */
export async function recordClaim(
  userId: string,
  channelId: string,
  channelTitle: string,
): Promise<ClaimOutcome> {
  const inserted = await query(
    `INSERT INTO creator_claims (user_id, channel_id, channel_title)
     VALUES ($1, $2, $3) ON CONFLICT (channel_id) DO NOTHING`,
    [userId, channelId, channelTitle],
  );

  if (inserted.rowCount === 1) {
    await promoteToCreator(userId);
    return "claimed";
  }

  const owner = await queryOne<{ user_id: string }>(
    "SELECT user_id FROM creator_claims WHERE channel_id = $1",
    [channelId],
  );
  return owner !== null && owner.user_id === userId ? "already_yours" : "taken_by_another";
}

/**
 * May this user edit extractions of this channel's videos?
 *
 * This — not the role on the JWT — is the authorisation check. A role says what
 * kind of person someone is; this says whether they own the specific thing
 * being written to. An admin is allowed through because moderating a bad
 * extraction is the job.
 */
export async function canEditChannel(userId: string, channelId: string): Promise<boolean> {
  if ((await getRole(userId)) === "admin") return true;
  const row = await queryOne<{ id: string }>(
    "SELECT id FROM creator_claims WHERE user_id = $1 AND channel_id = $2",
    [userId, channelId],
  );
  return row !== null;
}

// ---------------------------------------------------------------------------
// Saves
// ---------------------------------------------------------------------------

export async function isSaved(userId: string, videoId: string): Promise<boolean> {
  const row = await queryOne<{ video_id: string }>(
    "SELECT video_id FROM saves WHERE user_id = $1 AND video_id = $2",
    [userId, videoId],
  );
  return row !== null;
}

/** Idempotent: saving twice is the same as saving once, and returns the same. */
export async function save(userId: string, videoId: string): Promise<void> {
  await query(
    `INSERT INTO saves (user_id, video_id) VALUES ($1, $2)
     ON CONFLICT (user_id, video_id) DO NOTHING`,
    [userId, videoId],
  );
}

export async function unsave(userId: string, videoId: string): Promise<void> {
  await query("DELETE FROM saves WHERE user_id = $1 AND video_id = $2", [userId, videoId]);
}

export interface SavedRecipe {
  videoId: string;
  savedAt: string;
  cookedCount: number;
}

export async function listSaves(userId: string): Promise<SavedRecipe[]> {
  const { rows } = await query<{
    video_id: string;
    created_at: Date | string;
    cooked_count: string | number;
  }>(
    `SELECT s.video_id,
            s.created_at,
            (SELECT count(*) FROM cook_logs c
              WHERE c.user_id = s.user_id AND c.video_id = s.video_id) AS cooked_count
       FROM saves s
      WHERE s.user_id = $1
      ORDER BY s.created_at DESC`,
    [userId],
  );
  return rows.map((r) => ({
    videoId: r.video_id,
    savedAt: new Date(r.created_at).toISOString(),
    cookedCount: Number(r.cooked_count),
  }));
}

// ---------------------------------------------------------------------------
// Cooks and notes
// ---------------------------------------------------------------------------

/** Append-only. See the comment on cook_logs in migration 0002. */
export async function logCook(userId: string, videoId: string): Promise<number> {
  await query("INSERT INTO cook_logs (user_id, video_id) VALUES ($1, $2)", [userId, videoId]);
  return countCooks(userId, videoId);
}

export async function countCooks(userId: string, videoId: string): Promise<number> {
  const row = await queryOne<{ n: string | number }>(
    "SELECT count(*) AS n FROM cook_logs WHERE user_id = $1 AND video_id = $2",
    [userId, videoId],
  );
  return row === null ? 0 : Number(row.n);
}

/**
 * Count and most recent cook, in one round trip.
 *
 * `cook_logs` is append-only precisely so this question can be asked — a
 * counter column would give the count and lose the date. Both come back
 * together because the recipe page wants both and a second query for one
 * timestamp is a second network hop on the render path.
 *
 * `max()` over zero rows is NULL rather than an error, so a recipe never
 * cooked returns `{ count: 0, lastCookedAt: null }` without a special case.
 */
export async function cookHistory(
  userId: string,
  videoId: string,
): Promise<{ count: number; lastCookedAt: Date | null }> {
  const row = await queryOne<{ n: string | number; last: string | Date | null }>(
    `SELECT count(*) AS n, max(cooked_at) AS last
       FROM cook_logs
      WHERE user_id = $1 AND video_id = $2`,
    [userId, videoId],
  );
  if (row === null) return { count: 0, lastCookedAt: null };
  return {
    count: Number(row.n),
    lastCookedAt: row.last === null ? null : new Date(row.last),
  };
}

export async function getNote(userId: string, videoId: string): Promise<string | null> {
  const row = await queryOne<{ body: string }>(
    "SELECT body FROM notes WHERE user_id = $1 AND video_id = $2",
    [userId, videoId],
  );
  return row === null ? null : row.body;
}

/** An empty note is a deleted note; storing "" would be a row that renders as nothing. */
export async function setNote(userId: string, videoId: string, body: string): Promise<void> {
  const trimmed = body.trim();
  if (trimmed.length === 0) {
    await query("DELETE FROM notes WHERE user_id = $1 AND video_id = $2", [userId, videoId]);
    return;
  }
  await query(
    `INSERT INTO notes (user_id, video_id, body) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, video_id)
     DO UPDATE SET body = EXCLUDED.body, updated_at = now()`,
    [userId, videoId, trimmed],
  );
}
