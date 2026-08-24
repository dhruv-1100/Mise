import type { AnalyticsEvent } from "./events";
import type { AnalyticsSink } from "./sink";

/**
 * The browser sink.
 *
 * Everything a person does happens here; the only server-side event is `signup`
 * (see server.ts), because a new account is the one thing the browser cannot
 * reliably distinguish from a returning sign-in.
 *
 * posthog-js is imported dynamically rather than at module scope. This module
 * is reachable from server components through the components that call
 * `track()`, and a static import would drag a browser-only SDK into the server
 * graph — and into the bundle of anyone who never signs in.
 */

let sink: AnalyticsSink | null = null;

/**
 * Work queued while posthog-js is still loading.
 *
 * `initAnalytics()` awaits a dynamic import, so everything a page fires on
 * mount happens before there is a sink to fire it at. Queueing only `capture`
 * and letting the rest through to a no-op was a real bug and a quiet one: the
 * first `$pageview` of every session was dropped, and so was any `identify()`
 * that landed in the same tick — which is the one call retention cannot survive
 * losing (ADR 0004).
 *
 * Thunks rather than a list of events, so ordering between an identify and the
 * captures around it is preserved on flush.
 */
const pending: ((sink: AnalyticsSink) => void)[] = [];

/** Bounded, so a page that never initialises cannot grow this forever. */
const MAX_PENDING = 100;

let settled = false;

function dispatch(op: (sink: AnalyticsSink) => void): void {
  try {
    if (sink !== null) {
      op(sink);
      return;
    }
    if (settled) return; // init ran and found no key: there is nowhere to send.
    if (pending.length < MAX_PENDING) pending.push(op);
  } catch {
    // Deliberately swallowed. An analytics call that can break a click handler
    // is worse than no analytics: the failure mode becomes a broken product
    // rather than a missing chart.
  }
}

export const isAnalyticsConfigured = (): boolean =>
  process.env.NEXT_PUBLIC_POSTHOG_KEY !== undefined &&
  process.env.NEXT_PUBLIC_POSTHOG_KEY.length > 0;

let initialising: Promise<void> | null = null;

export function initAnalytics(): Promise<void> {
  initialising ??= (async () => {
    const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
    if (key === undefined || key.length === 0) {
      settled = true;
      pending.length = 0;
      return;
    }

    const { default: posthog } = await import("posthog-js");

    posthog.init(key, {
      api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://us.i.posthog.com",

      // Explicit events only. Autocapture would bury the seven events
      // BUILD_PLAN.md §6.3 actually asks about under every click on the page,
      // and on a free tier it would burn the event allowance doing it.
      autocapture: false,

      // The App Router does not reload between navigations, so PostHog's own
      // pageview detection sees exactly one. Captured manually in Analytics.tsx.
      capture_pageview: false,
      capture_pageleave: true,

      // No person profile until someone signs in. Anonymous events are still
      // recorded and are still stitched onto the person at identify() via
      // $anon_distinct_id, so retention cohorts keep the pre-signup history —
      // this only avoids creating a profile for every passing visitor.
      person_profiles: "identified_only",

      // The recipe page embeds a YouTube player and shows nothing private, but
      // notes and email addresses exist elsewhere on the site and there is no
      // reason for any of it to leave the browser.
      mask_all_text: true,
      disable_session_recording: true,

      // Off by default in posthog-js. Honouring it costs a few percent of the
      // numbers and is the right call for a site whose whole pitch is that it
      // does not need anything from you.
      respect_dnt: true,
    });

    sink = {
      capture(event) {
        posthog.capture(event.name, event.properties);
      },
      pageview(path) {
        posthog.capture("$pageview", { $current_url: path });
      },
      identify(userId, properties) {
        posthog.identify(userId, properties);
      },
      reset() {
        posthog.reset();
      },
    };
    settled = true;

    for (const op of pending.splice(0)) {
      try {
        op(sink);
      } catch {
        /* see dispatch() */
      }
    }
  })();

  return initialising;
}

/**
 * Fire an event.
 *
 * Never throws and never awaits — see the comment in `dispatch`.
 */
export function track(event: AnalyticsEvent): void {
  dispatch((s) => s.capture(event));
}

export function identify(
  userId: string,
  properties?: Record<string, string | number | boolean>,
): void {
  dispatch((s) => s.identify(userId, properties));
}

export function resetAnalytics(): void {
  dispatch((s) => s.reset());
}

export function pageview(path: string): void {
  dispatch((s) => s.pageview(path));
}

/** Test seam: swap the sink without a browser. */
export function __setSinkForTests(next: AnalyticsSink | null): void {
  sink = next;
  settled = next !== null;
  initialising = null;
  pending.length = 0;
}

/** Test seam: flush whatever queued while there was no sink. */
export function __flushForTests(next: AnalyticsSink): void {
  sink = next;
  settled = true;
  for (const op of pending.splice(0)) op(next);
}
