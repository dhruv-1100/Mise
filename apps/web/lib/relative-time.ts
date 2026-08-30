/**
 * "3 weeks ago", for dates a person recognises.
 *
 * Pure and testable, and separate from the component for that reason. Dates are
 * where off-by-one reads as a bug to the person looking at it — "cooked 0 days
 * ago" or "in 1 hours" — and none of that is visible to a type checker.
 *
 * `now` is a parameter rather than `Date.now()` so the tests are not flaky at
 * midnight and the function stays deterministic.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

export function relativeTime(then: Date, now: Date = new Date()): string {
  const ms = now.getTime() - then.getTime();

  // A clock skew or a row written a moment ago in another timezone should not
  // produce "in 3 seconds" on a page about something that already happened.
  if (ms < MINUTE) return "just now";

  if (ms < HOUR) return plural(Math.floor(ms / MINUTE), "minute");
  if (ms < DAY) return plural(Math.floor(ms / HOUR), "hour");
  if (ms < 2 * DAY) return "yesterday";
  if (ms < WEEK) return plural(Math.floor(ms / DAY), "day");
  if (ms < 5 * WEEK) return plural(Math.floor(ms / WEEK), "week");

  // Past a month, calendar months beat 30-day arithmetic: someone who cooked
  // something on the 3rd of last month expects "last month", not "4 weeks ago".
  const months =
    (now.getFullYear() - then.getFullYear()) * 12 + (now.getMonth() - then.getMonth());
  if (months < 12) return plural(Math.max(1, months), "month");
  return plural(Math.floor(months / 12), "year");
}

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"} ago`;
}
