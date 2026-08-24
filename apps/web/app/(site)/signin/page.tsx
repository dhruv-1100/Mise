import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { signInWithGoogle } from "@/app/actions/auth";
import { auth, isAuthConfigured } from "@/auth";
import { safeNextPath } from "@/lib/paths";

export const metadata: Metadata = { title: "Sign in" };

/**
 * Never prerendered.
 *
 * Without this the page is static whenever AUTH_GOOGLE_ID happens to be absent
 * at build time — and a deployment that sets it only at runtime would then ship
 * a permanently cached "accounts are not set up" page. The rendering mode of a
 * page must not depend on which environment variables the build machine had.
 */
export const dynamic = "force-dynamic";

/**
 * Sign-in.
 *
 * Deliberately unglamorous and deliberately optional — BUILD_PLAN.md §6.1 is
 * explicit that friction before value kills consumer products, so nothing on
 * the public surface routes through here. An account buys saves, notes and a
 * cooked count, and the copy says exactly that rather than implying a wall.
 */
export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  if (!isAuthConfigured) {
    return (
      <main className="mx-auto w-full max-w-[420px] flex-1 px-5 py-16">
        <h1 className="font-display text-[32px] leading-tight">Accounts are not set up</h1>
        <p className="mt-3 text-base leading-relaxed text-ink-soft">
          This deployment is running without sign-in configured. Everything else works —
          paste a video and get a recipe.
        </p>
      </main>
    );
  }

  if ((await auth())?.user !== undefined) redirect("/me");

  // Only ever a path on this site. An open redirect here would let someone send
  // a genuine "sign in to Mise" link that lands on a page they control.
  const next = safeNextPath((await searchParams).next);

  return (
    <main className="mx-auto w-full max-w-[420px] flex-1 px-5 py-16">
      <h1 className="font-display text-[32px] leading-tight tracking-[-0.02em]">
        Save what you cook
      </h1>
      <p className="mt-3 text-base leading-relaxed text-ink-soft">
        An account keeps your saved recipes, your notes and how many times you have cooked
        something. Recipes themselves never need one.
      </p>

      <form
        action={async () => {
          "use server";
          await signInWithGoogle(next);
        }}
        className="mt-8"
      >
        <button
          type="submit"
          className="flex h-11 w-full items-center justify-center rounded-md bg-accent px-4 text-[15px] font-semibold text-ground"
        >
          Continue with Google
        </button>
      </form>

      <p className="mt-4 text-[13px] leading-relaxed text-ink-faint">
        We ask Google only for your name and email address.
      </p>
    </main>
  );
}
