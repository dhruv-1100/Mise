import type { DefaultSession } from "next-auth";

import type { Role } from "@/lib/accounts";

/**
 * Module augmentation for the two fields this app adds.
 *
 * Without this, `session.user.role` is a type error and `token.role` is
 * `unknown`, and the usual workaround is a cast — which is exactly how an
 * authorisation field stops being checked. Declaring them makes every read of
 * `role` type-safe, and `no-explicit-any` keeps it that way.
 *
 * Note the second module name. `next-auth/jwt` is `export * from
 * "@auth/core/jwt"` — a re-export, not a definition — so `declare module
 * "next-auth/jwt"` silently creates a second, unrelated module instead of
 * augmenting the real one. It compiles, it looks right, and `token.role` stays
 * untyped. The interface has to be reopened where it is actually declared.
 */
declare module "next-auth" {
  interface Session {
    user: { id: string; role: Role } & DefaultSession["user"];
  }
}

declare module "@auth/core/jwt" {
  interface JWT {
    userId?: string;
    role?: Role;
  }
}
