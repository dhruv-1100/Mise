/**
 * Cook-mode timer arithmetic.
 *
 * Pure, and separate from the component, for one reason: a kitchen timer that
 * is wrong is worse than no timer, and this is the part that can be wrong. The
 * component around it is untestable per CLAUDE.md; this is not.
 *
 * EVERYTHING HERE IS DERIVED FROM AN ABSOLUTE END TIMESTAMP, never from
 * decrementing a counter. Browsers throttle timers in background tabs to once
 * a minute or stop them entirely, and cook mode is used on a phone that locks
 * its screen — a decrementing counter would silently run slow by exactly the
 * amount of time the person was not looking, which is the whole duration of a
 * simmer. Recomputing from `Date.now()` is correct no matter how long the tab
 * slept or how badly the interval drifted.
 */

/** Seconds left, floored at zero. Fractional input is rounded up so a timer reads "1:00" for the whole first second. */
export function remainingSeconds(endsAt: number, now: number): number {
  return Math.max(0, Math.ceil((endsAt - now) / 1000));
}

export function hasExpired(endsAt: number, now: number): boolean {
  return now >= endsAt;
}

/**
 * A countdown, as a cook reads it.
 *
 * Always mm:ss, zero-padded, so the digits do not shift width as it counts
 * down — the numbers are read at arm's length and a jumping layout is hard to
 * track. Hours appear only when there are hours, because a 5-minute timer
 * reading "00:05:00" wastes the glyphs that matter.
 */
export function formatCountdown(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = safe % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** How the duration is written before a timer is started — a label, not a countdown. */
export function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m === 0 ? `${s}s` : s === 0 ? `${m} min` : `${m}:${String(s).padStart(2, "0")}`;
}

/** Spoken form, for the screen-reader announcement when a timer finishes. */
export function describeDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  const parts: string[] = [];
  if (m > 0) parts.push(`${m} minute${m === 1 ? "" : "s"}`);
  if (s > 0) parts.push(`${s} second${s === 1 ? "" : "s"}`);
  return parts.length === 0 ? "0 seconds" : parts.join(" ");
}
