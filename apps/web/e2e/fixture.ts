/**
 * The one recipe the end-to-end specs run against.
 *
 * Deliberately fixed rather than fetched. Pointing these at the live extractor
 * would make them depend on the network, on YouTube quota, and on Redis cache
 * TTLs — the production cache expired twice during one afternoon of work here.
 * A spec that fails because a cache entry aged out teaches nothing.
 *
 * Shaped to exercise the things worth testing:
 *   - a step with a 2-second duration, so the timer's ring is testable in a
 *     spec rather than in sixty seconds of waiting
 *   - a second timed step, so timers surviving navigation can be checked
 *   - imperial units, a vague quantity and a count, so the metric toggle's
 *     "convert what you can and leave the rest" rule is visible
 */
export const VIDEO_ID = "e2etestvid0";

export const RECIPE = {
  videoId: VIDEO_ID,
  title: "End-to-end Test Curry",
  creator: {
    name: "Playwright Kitchen",
    channelId: "UCe2ee2ee2ee2ee2ee2ee2e",
    channelUrl: "https://www.youtube.com/channel/UCe2ee2ee2ee2ee2ee2ee2e",
  },
  ingredients: [
    {
      name: "olive oil",
      qty: 2,
      qtyText: null,
      unit: "tbsp",
      prep: null,
      optional: false,
      source: "description",
      confidence: 0.9,
    },
    {
      name: "onions",
      qty: 2,
      qtyText: null,
      unit: null,
      prep: "sliced",
      optional: false,
      source: "description",
      confidence: 0.9,
    },
    {
      name: "salt",
      qty: null,
      qtyText: "to taste",
      unit: null,
      prep: null,
      optional: false,
      source: "description",
      confidence: 0.6,
    },
  ],
  steps: [
    {
      index: 1,
      text: "Warm the oil in a heavy pan.",
      durationS: 2,
      tempC: null,
      source: "description",
    },
    {
      index: 2,
      text: "Add the onions and cook until golden.",
      durationS: 3,
      tempC: null,
      source: "description",
    },
    {
      index: 3,
      text: "Season and serve.",
      durationS: null,
      tempC: null,
      source: "description",
    },
  ],
  yield: { qty: 4, qtyText: null, unit: "serving" },
  equipment: ["heavy pan"],
  sources: ["description"],
  conflicts: [],
  extractedAt: "2026-08-28T00:00:00Z",
};
