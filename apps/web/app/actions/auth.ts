"use server";

import { signIn, signOut } from "@/auth";
import { YOUTUBE_READONLY_SCOPE } from "@/lib/youtube";

/**
 * Sign-in entry points.
 *
 * Server actions rather than client-side calls to `next-auth/react`, so the
 * client secret and the scope list stay on the server and the pages that use
 * them can remain server components.
 */

export async function signInWithGoogle(redirectTo: string): Promise<void> {
  await signIn("google", { redirectTo });
}

/**
 * Incremental authorisation for a channel claim.
 *
 * The extra scope is requested here and nowhere else. A visitor signing up to
 * save a recipe is never shown a consent screen asking for access to their
 * YouTube account — they see it only if and when they choose to prove they own
 * a channel, which is the difference between an OAuth flow people complete and
 * one they abandon.
 *
 * `prompt: "consent"` is required rather than decorative: Google skips the
 * consent screen entirely for an account that has already authorised this app,
 * and would hand back a token carrying only the original scopes. The claim
 * would then fail with a 403 that looks like a bug.
 *
 * `include_granted_scopes` keeps the earlier grants alive alongside the new
 * one, so consenting here does not revoke the sign-in scopes.
 */
export async function signInToClaimChannel(): Promise<void> {
  await signIn(
    "google",
    { redirectTo: "/creator" },
    {
      scope: `openid email profile ${YOUTUBE_READONLY_SCOPE}`,
      prompt: "consent",
      include_granted_scopes: "true",
      access_type: "online",
    },
  );
}

export async function signOutEverywhere(): Promise<void> {
  await signOut({ redirectTo: "/" });
}
