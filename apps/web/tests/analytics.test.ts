import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { EVENT_NAMES } from "../lib/analytics/events";
import { FakeSink, noopSink } from "../lib/analytics/sink";
import {
  __flushForTests,
  __setSinkForTests,
  identify,
  pageview,
  resetAnalytics,
  track,
} from "../lib/analytics/client";

const ROOT = join(import.meta.dirname, "..");

function sources(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry === "tests") continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sources(path, found);
    else if (/\.(ts|tsx)$/.test(entry) && !path.includes("lib/analytics")) found.push(path);
  }
  return found;
}

/**
 * The failure this guards against is the only one that matters here, and it is
 * silent: an event defined in the contract, agreed in the plan, and never
 * actually fired. Nothing breaks. A chart reads zero, and the first person to
 * notice is whoever tries to build the D7 cohort three months later — by which
 * point the data does not exist and cannot be backfilled (BUILD_PLAN.md §1).
 */
describe("every event in the contract is actually fired somewhere", () => {
  const code = sources(ROOT)
    .map((f) => readFileSync(f, "utf8"))
    .join("\n");

  it.each(EVENT_NAMES.map((n) => [n]))("%s", (name) => {
    expect(code).toContain(`name: "${name}"`);
  });

  it("covers the seven events BUILD_PLAN.md §6.3 names", () => {
    expect([...EVENT_NAMES].sort()).toEqual(
      [
        "cook_mode_completed",
        "cook_mode_started",
        "recipe_extracted",
        "recipe_saved",
        "recipe_viewed",
        "servings_changed",
        "signup",
      ].sort(),
    );
  });
});

describe("track", () => {
  let sink: FakeSink;

  beforeEach(() => {
    sink = new FakeSink();
    __setSinkForTests(sink);
  });

  it("passes the event through with its properties intact", () => {
    track({ name: "recipe_saved", properties: { videoId: "5BYEBHVCs6M", saved: true } });
    expect(sink.only("recipe_saved")).toEqual([
      { name: "recipe_saved", properties: { videoId: "5BYEBHVCs6M", saved: true } },
    ]);
  });

  it("carries an un-save as the same event with a direction", () => {
    track({ name: "recipe_saved", properties: { videoId: "5BYEBHVCs6M", saved: false } });
    expect(sink.only("recipe_saved")[0]!.properties.saved).toBe(false);
  });

  it("routes a pageview separately from product events", () => {
    pageview("https://mise.example/r/5BYEBHVCs6M");
    expect(sink.pageviews).toEqual(["https://mise.example/r/5BYEBHVCs6M"]);
    expect(sink.names()).toEqual([]);
  });

  it("identifies with properties", () => {
    identify("user-1", { role: "creator" });
    expect(sink.identities).toEqual([{ userId: "user-1", properties: { role: "creator" } }]);
  });

  it("resets", () => {
    resetAnalytics();
    expect(sink.resets).toBe(1);
  });

  // A sink that throws must not take a click handler down with it. This is the
  // whole reason track() has a try/catch, and an untested catch block is a
  // guess.
  it("never throws, whatever the sink does", () => {
    __setSinkForTests({
      capture() {
        throw new Error("vendor down");
      },
      pageview() {
        throw new Error("vendor down");
      },
      identify() {
        throw new Error("vendor down");
      },
      reset() {
        throw new Error("vendor down");
      },
    });

    expect(() => {
      track({ name: "cook_mode_started", properties: { videoId: "5BYEBHVCs6M", stepCount: 3 } });
      pageview("/");
      identify("user-1");
      resetAnalytics();
    }).not.toThrow();
  });
});

describe("noopSink", () => {
  it("accepts everything and does nothing", () => {
    expect(() => {
      noopSink.capture({ name: "signup", properties: { method: "google" } });
      noopSink.pageview("/");
      noopSink.identify("user-1");
      noopSink.reset();
    }).not.toThrow();
  });
});

describe("queueing before the SDK has loaded", () => {
  // initAnalytics() awaits a dynamic import, so a page fires its mount events
  // into a void. Everything must be held and replayed in order — this was a
  // real bug: the first $pageview of every session was silently dropped, and an
  // identify() in the same tick would have gone with it.
  beforeEach(() => {
    __setSinkForTests(null);
  });

  it("replays captures, pageviews and identifies once a sink arrives", () => {
    track({ name: "recipe_viewed", properties: { videoId: "aaaaaaaaaaa", ingredientCount: 3, stepCount: 4 } });
    pageview("/r/aaaaaaaaaaa");
    identify("user-1", { role: "user" });

    const sink = new FakeSink();
    expect(sink.events).toEqual([]);

    __flushForTests(sink);

    expect(sink.names()).toEqual(["recipe_viewed"]);
    expect(sink.pageviews).toEqual(["/r/aaaaaaaaaaa"]);
    expect(sink.identities).toEqual([{ userId: "user-1", properties: { role: "user" } }]);
  });

  it("preserves the order of an identify against the captures around it", () => {
    const order: string[] = [];
    track({ name: "recipe_viewed", properties: { videoId: "aaaaaaaaaaa", ingredientCount: 1, stepCount: 1 } });
    identify("user-1");
    track({ name: "recipe_saved", properties: { videoId: "aaaaaaaaaaa", saved: true } });

    __flushForTests({
      capture: (e) => order.push(e.name),
      pageview: () => order.push("pageview"),
      identify: () => order.push("identify"),
      reset: () => order.push("reset"),
    });

    expect(order).toEqual(["recipe_viewed", "identify", "recipe_saved"]);
  });

  it("does not grow without bound when nothing ever initialises", () => {
    for (let i = 0; i < 500; i++) {
      track({ name: "recipe_viewed", properties: { videoId: "aaaaaaaaaaa", ingredientCount: 0, stepCount: 0 } });
    }
    const sink = new FakeSink();
    __flushForTests(sink);
    expect(sink.events.length).toBeLessThanOrEqual(100);
  });
});
