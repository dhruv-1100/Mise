import type { AnalyticsEvent } from "./events";

/**
 * Where events go.
 *
 * The same shape as `LlmProvider` in the extractor, for the same reason: the
 * interesting logic is which events fire and with what, and that has to be
 * testable without a network, a key, or a vendor. PostHog is one implementation
 * of this, not a dependency of the code that calls it.
 */
export interface AnalyticsSink {
  capture(event: AnalyticsEvent): void;

  /**
   * A page view.
   *
   * Separate from `capture` because `$pageview` is PostHog's own event, not one
   * of the seven this product defines. Folding it into the typed union would
   * mean either inventing a fake product event for it or loosening the union
   * until it stops catching typos.
   */
  pageview(path: string): void;

  /**
   * Attach every event from here on — and, crucially, every anonymous event
   * from before — to this person.
   *
   * The stitching is the whole reason this method exists. Someone lands, pastes
   * a video, cooks it, and signs up two days later; without an explicit
   * identify at sign-in those first two days belong to an anonymous id and the
   * D1 number is quietly wrong. Retention cannot be reconstructed afterwards
   * (BUILD_PLAN.md §1), so this is the one call that must not be forgotten.
   */
  identify(userId: string, properties?: Record<string, string | number | boolean>): void;

  /** On sign-out. Otherwise the next person on a shared browser inherits an id. */
  reset(): void;
}

/**
 * The default.
 *
 * No key configured is a normal state, not a broken one — the whole app works
 * without analytics, and a missing environment variable must never be the
 * reason a recipe page throws.
 */
export const noopSink: AnalyticsSink = {
  capture() {},
  pageview() {},
  identify() {},
  reset() {},
};

/** Records instead of sending. The test suite's sink. */
export class FakeSink implements AnalyticsSink {
  readonly events: AnalyticsEvent[] = [];
  readonly identities: { userId: string; properties?: Record<string, unknown> }[] = [];
  readonly pageviews: string[] = [];
  resets = 0;

  capture(event: AnalyticsEvent): void {
    this.events.push(event);
  }

  pageview(path: string): void {
    this.pageviews.push(path);
  }

  identify(userId: string, properties?: Record<string, string | number | boolean>): void {
    this.identities.push(properties === undefined ? { userId } : { userId, properties });
  }

  reset(): void {
    this.resets++;
  }

  names(): string[] {
    return this.events.map((e) => e.name);
  }

  only<N extends AnalyticsEvent["name"]>(name: N): Extract<AnalyticsEvent, { name: N }>[] {
    return this.events.filter(
      (e): e is Extract<AnalyticsEvent, { name: N }> => e.name === name,
    );
  }
}
