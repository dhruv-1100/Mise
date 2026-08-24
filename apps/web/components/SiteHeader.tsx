import Link from "next/link";

import { signOutEverywhere } from "@/app/actions/auth";
import { auth, isAuthConfigured } from "@/auth";

/**
 * The one piece of chrome shared by every page except cook mode.
 *
 * A server component, so the session is read during render and there is no
 * signed-out flash and no client-side session fetch on first paint. Sign-out is
 * a form posting to a server action rather than an onClick, which is the better
 * shape anyway: it works without JavaScript.
 *
 * KNOWN COST. Reading the session reads cookies, which opts every page under
 * this layout into dynamic rendering — including the home page, which would
 * otherwise be static. That is a deliberate trade: one cheap server render
 * against a client-side session fetch and a signed-out flash on every page.
 * Partial prerendering is the real fix and is not stable in Next 15; when it
 * is, the shell becomes static again and only this header stays dynamic.
 */
export async function SiteHeader() {
  const session = isAuthConfigured ? await auth() : null;
  const user = session?.user;

  return (
    <header className="border-b border-line">
      <div className="mx-auto flex w-full max-w-[960px] items-center justify-between gap-4 px-5 py-3">
        <Link href="/" className="font-display text-xl tracking-[-0.01em]">
          Mise
        </Link>

        {/* No accounts configured is a valid deployment (BUILD_PLAN.md §6.1
            allows the whole public surface without them), so the header simply
            has nothing on the right rather than a broken sign-in link. */}
        {!isAuthConfigured ? null : user === undefined ? (
          <Link
            href="/signin"
            className="flex h-11 items-center rounded-md px-3 text-[15px] font-semibold text-accent-deep"
          >
            Sign in
          </Link>
        ) : (
          <nav className="flex items-center gap-1">
            <Link
              href="/me"
              className="flex h-11 items-center rounded-md px-3 text-[15px] font-semibold"
            >
              Saved
            </Link>
            <Link
              href="/creator"
              className="flex h-11 items-center rounded-md px-3 text-[15px] text-ink-soft"
            >
              {user.role === "creator" || user.role === "admin" ? "Your channel" : "For creators"}
            </Link>
            <form action={signOutEverywhere}>
              <button
                type="submit"
                className="flex h-11 items-center rounded-md px-3 text-[15px] text-ink-soft"
              >
                Sign out
              </button>
            </form>
          </nav>
        )}
      </div>
    </header>
  );
}
