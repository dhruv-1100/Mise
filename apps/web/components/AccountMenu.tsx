import { signOutEverywhere, switchAccount } from "@/app/actions/auth";

/**
 * Who you are signed in as, and how to stop being them.
 *
 * The header used to show "Saved / For creators / Sign out" and never said
 * whose account it was. Reported as "there should be an account switcher" —
 * which was the symptom. The cause was that the identity was invisible, so the
 * only way to find out which of two Google accounts you had landed in was to
 * sign out and watch the chooser.
 *
 * A `<details>` disclosure rather than a JavaScript dropdown, for the same
 * reason sign-out is a form posting to a server action: it works with
 * JavaScript disabled, it is keyboard-accessible without any of it being
 * written here, and it keeps the header a server component so the session is
 * read during render and there is no signed-out flash.
 */
export function AccountMenu({
  name,
  email,
  image,
  role,
  returnTo,
}: {
  name: string | null | undefined;
  email: string | null | undefined;
  image: string | null | undefined;
  role: string;
  returnTo: string;
}) {
  // Google's own label for the account, falling back through what the profile
  // actually gave us. An avatar with no name beside it identifies nobody.
  const label = name ?? email ?? "Account";

  return (
    <details className="relative">
      <summary
        className="flex h-11 cursor-pointer list-none items-center gap-2 rounded-md px-2 text-[15px] font-semibold [&::-webkit-details-marker]:hidden"
        aria-label={`Signed in as ${label}. Account menu`}
      >
        {image ? (
          /* Plain <img>: next/image would need remotePatterns for
             lh3.googleusercontent.com, and a 24px avatar is not worth the
             optimisation pipeline or the config surface. */
          // eslint-disable-next-line @next/next/no-img-element
          <img src={image} alt="" width={24} height={24} className="size-6 rounded-full" />
        ) : (
          <span className="flex size-6 items-center justify-center rounded-full bg-accent-wash text-[11px] font-bold text-accent-deep">
            {label.slice(0, 1).toUpperCase()}
          </span>
        )}
        <span className="max-w-[9rem] truncate">{label}</span>
        <span aria-hidden="true" className="text-ink-faint">
          ▾
        </span>
      </summary>

      <div className="absolute right-0 z-20 mt-1 w-[16rem] rounded-lg border border-line bg-surface p-1.5 shadow-lg">
        <div className="border-b border-line px-3 py-2.5">
          <p className="truncate text-[15px] font-semibold">{label}</p>
          {/* The email is the part that actually distinguishes two Google
              accounts; the display name is often identical on both. */}
          {email !== null && email !== undefined && (
            <p className="truncate text-[13px] text-ink-soft">{email}</p>
          )}
          {(role === "creator" || role === "admin") && (
            <p className="mt-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-accent-deep">
              {role}
            </p>
          )}
        </div>

        <form action={switchAccount.bind(null, returnTo)}>
          <button
            type="submit"
            className="flex h-11 w-full items-center rounded-md px-3 text-left text-[15px]"
          >
            Switch account
          </button>
        </form>

        <form action={signOutEverywhere}>
          <button
            type="submit"
            className="flex h-11 w-full items-center rounded-md px-3 text-left text-[15px] text-ink-soft"
          >
            Sign out
          </button>
        </form>
      </div>
    </details>
  );
}
