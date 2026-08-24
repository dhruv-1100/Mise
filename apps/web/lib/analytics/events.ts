/**
 * The product event contract.
 *
 * BUILD_PLAN.md §6.3 names seven events. They are a discriminated union rather
 * than string literals passed to a `capture(name, props)` function, so a typo
 * is a compile error instead of a metric that reads zero for three weeks before
 * anyone notices. The property shapes are part of the contract for the same
 * reason: a funnel built on `videoId` breaks silently the day someone sends
 * `video_id`.
 *
 * NOTHING IN HERE CARRIES CONTENT. Every property is an id, a count, a boolean
 * or a duration. Recipe text, ingredient names, note bodies and titles are
 * absent on purpose: CLAUDE.md forbids persisting raw fetched text, and an
 * analytics vendor is persistence like any other. It is also just good manners
 * — a note someone wrote about their own dinner is not telemetry.
 */

export type AnalyticsEvent =
  /** A new account, exactly once per person. Fired server-side; see server.ts. */
  | { name: "signup"; properties: { method: "google" } }

  /** An extraction the person actually waited for and got a recipe from. */
  | {
      name: "recipe_extracted";
      properties: { videoId: string; cached: boolean; waitedMs: number };
    }

  | {
      name: "recipe_viewed";
      properties: { videoId: string; ingredientCount: number; stepCount: number };
    }

  /** `saved: false` is an un-save. One event with a direction beats two events. */
  | { name: "recipe_saved"; properties: { videoId: string; saved: boolean } }

  | { name: "cook_mode_started"; properties: { videoId: string; stepCount: number } }

  /**
   * Reaching the last step and pressing Done.
   *
   * The strongest signal this product has: someone stood in a kitchen and
   * cooked the thing. `stepsSeen` distinguishes a real cook from a skim to the
   * end, which the completion count alone cannot.
   */
  | {
      name: "cook_mode_completed";
      properties: { videoId: string; stepCount: number; stepsSeen: number; elapsedMs: number };
    }

  /** The signature interaction. `factor` is what makes it comparable across recipes. */
  | {
      name: "servings_changed";
      properties: { videoId: string; from: number; to: number; factor: number };
    };

export type AnalyticsEventName = AnalyticsEvent["name"];

/**
 * Every event name, as data.
 *
 * Exists so the test suite can assert that all seven survive a round trip
 * through a sink, and so a name added to the union but never fired is visible.
 */
export const EVENT_NAMES: readonly AnalyticsEventName[] = [
  "signup",
  "recipe_extracted",
  "recipe_viewed",
  "recipe_saved",
  "cook_mode_started",
  "cook_mode_completed",
  "servings_changed",
];
