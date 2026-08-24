"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

import { identify, initAnalytics, pageview, resetAnalytics } from "@/lib/analytics/client";

/**
 * Analytics wiring, and nothing else.
 *
 * Renders nothing. Three jobs, in order of how badly each one breaks the
 * numbers if it is missing:
 *
 *   1. identify() on sign-in. Without it, everything someone did before they
 *      signed up belongs to an anonymous id, and every retention cohort is
 *      quietly wrong from day one. BUILD_PLAN.md §1: retention cannot be
 *      reconstructed retroactively.
 *   2. reset() on sign-out, so the next person on a shared laptop is not
 *      recorded as the last one.
 *   3. Pageviews. The App Router never reloads the document, so PostHog's own
 *      detection sees exactly one pageview per session; this fires on every
 *      route change instead.
 */
export function Analytics({ userId, role }: { userId?: string; role?: string }) {
  const pathname = usePathname();
  const identified = useRef<string | null>(null);

  useEffect(() => {
    void initAnalytics();
  }, []);

  useEffect(() => {
    if (userId !== undefined) {
      // Re-identifying the same person on every navigation would be noise, so
      // this only fires on an actual change of who is signed in.
      if (identified.current === userId) return;
      identified.current = userId;
      identify(userId, role === undefined ? undefined : { role });
      return;
    }

    // Only a real sign-out resets. A first load by someone who was never
    // signed in must not clear the anonymous id they arrived with — that id is
    // what stitches their pre-signup history onto the account they may create
    // in a minute.
    if (identified.current !== null) {
      identified.current = null;
      resetAnalytics();
    }
  }, [userId, role]);

  useEffect(() => {
    pageview(window.location.href);
  }, [pathname]);

  return null;
}
