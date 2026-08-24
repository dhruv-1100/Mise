import PostgresAdapter from "@auth/pg-adapter";
import NextAuth, { type NextAuthConfig, type NextAuthResult } from "next-auth";
import Google from "next-auth/providers/google";

import { adapterClient, isConfigured } from "@/lib/db";
import { getRole, recordClaim, type Role } from "@/lib/accounts";
import { captureServerSide } from "@/lib/analytics/server";
import { fetchOwnedChannel, YOUTUBE_READONLY_SCOPE } from "@/lib/youtube";

/**
 * Authentication.
 *
 * The token lifecycle, the reason sessions are JWTs while users are rows, and
 * why the YouTube access token is never persisted are all argued in
 * docs/adr/0003-auth-and-sessions.md. Read that before changing anything here.
 *
 * Two invariants this file exists to hold:
 *
 *   1. No OAuth token ever enters the session cookie. The cookie is encrypted,
 *      but "encrypted thing sitting in a browser" is a worse place for a
 *      credential than "row in Postgres", and the YouTube token is not even
 *      that — it is used once during the callback and dropped.
 *
 *   2. `role` on the session is a UI affordance, not an authorisation
 *      decision. Every write that depends on who someone is re-reads from the
 *      database. See `canEditChannel` in lib/accounts.ts.
 */

/**
 * Sign-in is optional infrastructure.
 *
 * BUILD_PLAN.md §6.1 is emphatic that the public surface carries no signup
 * wall, which means a deployment with no Google credentials and no database
 * must still serve recipes. Rather than crashing at import time, the provider
 * list is empty and every session is null — the app renders signed-out.
 */
const googleId = process.env.AUTH_GOOGLE_ID;
const googleSecret = process.env.AUTH_GOOGLE_SECRET;

export const isAuthConfigured =
  isConfigured && googleId !== undefined && googleSecret !== undefined;

/** Where the claim flow sends people back to, with an outcome to render. */
const CLAIM_RETURN = "/creator";

const config: NextAuthConfig = {
  // The adapter persists users, roles and claims. The session strategy below
  // still keeps the session itself stateless — see the ADR; this combination is
  // supported and is what BUILD_PLAN.md §6.2 asks for by naming both.
  ...(isAuthConfigured ? { adapter: PostgresAdapter(adapterClient()) } : {}),

  session: { strategy: "jwt" },

  providers:
    googleId !== undefined && googleSecret !== undefined
    ? [
        Google({
          clientId: googleId,
          clientSecret: googleSecret,
          // Deliberately minimal. The YouTube scope is requested later, only
          // from the people who want to claim a channel, and only at the moment
          // they ask — see `signInToClaimChannel` in lib/claim.ts. Asking every
          // visitor for read access to their YouTube account at signup would be
          // both a worse consent screen and a worse thing to do.
          authorization: { params: { scope: "openid email profile" } },
          allowDangerousEmailAccountLinking: false,
        }),
      ]
    : [],

  pages: { signIn: "/signin" },

  /**
   * `signup`, fired exactly once per person.
   *
   * BUILD_PLAN.md §6.3 lists it first, and §1 warns that retention is the one
   * number that cannot be reconstructed later — a D30 cohort needs to know the
   * day the account was created, from the day it was created.
   *
   * `createUser` is the only place that knows. The browser sees an identical
   * redirect for a new account and a returning sign-in, and `signIn` fires for
   * both. This fires when Auth.js has just inserted the row.
   */
  events: {
    async createUser({ user }) {
      if (user.id === undefined) return;
      await captureServerSide(user.id, { name: "signup", properties: { method: "google" } });
    },
  },

  callbacks: {
    /**
     * Runs inside the OAuth callback, before any session exists.
     *
     * This is where a channel claim is verified and recorded, because it is the
     * one moment the YouTube access token exists — in memory, on the server,
     * having just come back from Google. Doing it here means the token is used
     * and dropped in the same function, and never written anywhere.
     *
     * Returning a string redirects there instead of to the callback URL, which
     * is how the outcome reaches the page without a token round-trip.
     */
    async signIn({ user, account }) {
      const grantedYouTube = account?.scope?.includes(YOUTUBE_READONLY_SCOPE) ?? false;
      if (!grantedYouTube || account?.access_token === undefined) return true;

      // The adapter has already created or found the user by this point, so the
      // id is real and a claim can reference it.
      if (user.id === undefined) return `${CLAIM_RETURN}?claim=unavailable`;

      const lookup = await fetchOwnedChannel(account.access_token);
      if (!lookup.ok) return `${CLAIM_RETURN}?claim=${lookup.reason}`;

      const outcome = await recordClaim(user.id, lookup.channel.channelId, lookup.channel.title);
      return `${CLAIM_RETURN}?claim=${outcome}`;
    },

    /**
     * Mint and refresh the token's contents.
     *
     * `role` is read from the database rather than copied off `user`, and again
     * on an explicit update. A claim promotes the row mid-session; without the
     * update branch the cookie would keep saying "user" until it expired, and
     * the creator tools would stay hidden from someone who had just proved they
     * own the channel.
     */
    async jwt({ token, user, trigger }) {
      if (user?.id !== undefined) token.userId = user.id;

      if (token.userId !== undefined && (user !== undefined || trigger === "update")) {
        token.role = await getRole(token.userId);
      }
      return token;
    },

    async session({ session, token }) {
      if (token.userId !== undefined) session.user.id = token.userId;
      session.user.role = token.role ?? "user";
      return session;
    },
  },
};

/**
 * Each export is annotated rather than inferred.
 *
 * Without the annotations tsc raises TS2742 — it tries to name the inferred
 * type through this project's `@/*` path alias, which maps to the package root
 * and so produces `@/node_modules/next-auth/lib`, a path that means nothing
 * outside this machine. Naming the types from the library's own public alias is
 * the fix, and it is a real one: these four are the entire public surface of
 * this file, and now they are declared rather than whatever inference produced.
 */
const nextAuth: NextAuthResult = NextAuth(config);

export const handlers: NextAuthResult["handlers"] = nextAuth.handlers;
export const auth: NextAuthResult["auth"] = nextAuth.auth;
export const signIn: NextAuthResult["signIn"] = nextAuth.signIn;
export const signOut: NextAuthResult["signOut"] = nextAuth.signOut;

export type { Role };
