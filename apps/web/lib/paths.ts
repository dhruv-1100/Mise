/**
 * Pure path helpers. No `server-only` here on purpose: these are the bits worth
 * unit testing, and a module that throws outside a request context cannot be.
 */

/**
 * Sanitise a post-sign-in redirect target.
 *
 * `?next=` comes from the URL bar, which means it comes from whoever wrote the
 * link. Without this, `/signin?next=https://evil.example` produces a genuine
 * mise.app sign-in page that hands the person straight to someone else's site
 * afterwards — the classic open redirect, and a good one, because the domain in
 * the address bar is real right up until it isn't.
 *
 * Accepted: a single-slash absolute path on this site. Rejected: anything with
 * a scheme, anything protocol-relative (`//evil.example`, which browsers treat
 * as absolute), any backslash (which some browsers normalise to a slash), and
 * anything not starting with `/`.
 */
export function safeNextPath(raw: string | undefined, fallback = "/me"): string {
  if (raw === undefined || raw.length === 0) return fallback;
  if (!raw.startsWith("/")) return fallback;
  if (raw.startsWith("//")) return fallback;
  if (raw.includes("\\")) return fallback;
  if (raw.includes("://")) return fallback;
  return raw;
}
