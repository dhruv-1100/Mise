"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";

import type { Recipe } from "@mise/schema";
import { useCallback, useEffect, useRef, useState } from "react";

import { track } from "@/lib/analytics/client";

/**
 * Cook mode.
 *
 * The constraint that shaped the whole type scale: legible at arm's length, on
 * a counter, by someone with wet hands. 28px step text, an 18px floor, 44px
 * targets, inverted for glare.
 */
export function CookMode({ recipe, signedIn }: { recipe: Recipe; signedIn: boolean }) {
  const router = useRouter();
  const [index, setIndex] = useState(0);
  const [finishing, setFinishing] = useState(false);
  const step = recipe.steps[index];
  const total = recipe.steps.length;

  const wakeLock = useWakeLock();

  const openedAt = useRef(Date.now());
  const deepest = useRef(0);
  deepest.current = Math.max(deepest.current, index);

  useEffect(() => {
    track({
      name: "cook_mode_started",
      properties: { videoId: recipe.videoId, stepCount: recipe.steps.length },
    });
  }, [recipe.videoId, recipe.steps.length]);

  /**
   * Finishing is an event, not a dead end.
   *
   * The last step used to leave a button reading "Done" that was disabled —
   * the one moment worth recording, and there was nothing to press. A completed
   * cook is the strongest product signal this app has (BUILD_PLAN.md §1 counts
   * cook-mode sessions), so it is written down and the person is returned to
   * the recipe.
   *
   * The count is best-effort: a failed request must never trap someone in cook
   * mode over a piece of bookkeeping.
   */
  const finish = useCallback(async () => {
    setFinishing(true);
    track({
      name: "cook_mode_completed",
      properties: {
        videoId: recipe.videoId,
        stepCount: total,
        // How many steps they actually moved through. A completion where
        // stepsSeen is 2 of 14 is someone who tapped to the end, and counting
        // it as a cook would flatter the strongest number this product has.
        stepsSeen: deepest.current + 1,
        elapsedMs: Date.now() - openedAt.current,
      },
    });
    if (signedIn) {
      await fetch(`/api/recipes/${recipe.videoId}/cooked`, { method: "POST" }).catch(() => null);
    }
    router.push(`/r/${recipe.videoId}`);
  }, [recipe.videoId, router, signedIn, total]);

  const next = useCallback(
    () => setIndex((i) => Math.min(total - 1, i + 1)),
    [total],
  );
  const prev = useCallback(() => setIndex((i) => Math.max(0, i - 1)), []);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "ArrowRight") next();
      if (event.key === "ArrowLeft") prev();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [next, prev]);

  if (step === undefined) return null;

  return (
    <main className="flex min-h-dvh flex-col bg-cook-ground text-cook-ink">
      <div className="flex items-center justify-between px-5 py-4">
        <Link
          href={`/r/${recipe.videoId}`}
          aria-label="Leave cook mode"
          className="flex size-11 items-center justify-center text-cook-ink-soft"
        >
          ✕
        </Link>
        <p className="text-sm font-semibold tabular-nums text-cook-ink-soft">
          Step {index + 1} of {total}
        </p>
        <span
          className="flex h-11 items-center text-[13px] font-semibold text-cook-ink-soft"
          title={
            wakeLock === "unsupported"
              ? "This browser cannot keep the screen awake"
              : undefined
          }
        >
          {wakeLock === "held" ? "Screen on" : wakeLock === "unsupported" ? "" : "…"}
        </span>
      </div>

      <ol className="flex gap-1 px-5 pb-2" aria-hidden="true">
        {recipe.steps.map((s, i) => (
          <li
            key={s.index}
            className={`h-[3px] flex-1 rounded-full ${i <= index ? "bg-accent" : "bg-cook-surface"}`}
          />
        ))}
      </ol>

      {/* One live region: the step text is what changes, and announcing the
          chrome around it on every tap would be noise. */}
      <div className="flex-1 px-6 pt-9" aria-live="polite">
        <p className="m-0 text-[28px] font-medium leading-[1.35]">{step.text}</p>

        {(step.durationS !== null || step.tempC !== null) && (
          <div className="mt-6 flex flex-wrap gap-3">
            {step.durationS !== null && (
              <span className="rounded-lg bg-cook-surface px-5 py-4 text-xl font-semibold tabular-nums">
                {formatDuration(step.durationS)}
              </span>
            )}
            {step.tempC !== null && (
              <span className="rounded-lg bg-cook-surface px-5 py-4 text-xl font-semibold tabular-nums">
                {step.tempC}°C
              </span>
            )}
          </div>
        )}
      </div>

      <div className="flex gap-3 px-5 pb-9 pt-5">
        <button
          type="button"
          onClick={prev}
          disabled={index === 0}
          aria-label="Previous step"
          className="h-[60px] w-[76px] rounded-md border border-cook-surface text-2xl text-cook-ink-soft disabled:opacity-40"
        >
          ←
        </button>
        <button
          type="button"
          onClick={index === total - 1 ? () => void finish() : next}
          disabled={finishing}
          className="h-[60px] flex-1 rounded-md bg-cook-ink text-lg font-bold text-cook-ground disabled:opacity-40"
        >
          {index === total - 1 ? (finishing ? "Saving…" : "Done") : "Next step"}
        </button>
      </div>
    </main>
  );
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m === 0 ? `${s}s` : s === 0 ? `${m} min` : `${m}:${String(s).padStart(2, "0")}`;
}

type WakeLockState = "idle" | "held" | "unsupported";

/**
 * Keep the screen awake while cooking.
 *
 * Re-acquires on visibility change: the lock is released whenever the tab is
 * hidden, including a screen the user turned off themselves, so without this
 * it silently stops working the first time they look away.
 */
function useWakeLock(): WakeLockState {
  const [state, setState] = useState<WakeLockState>("idle");
  const held = useRef<WakeLockSentinel | null>(null);

  useEffect(() => {
    if (!("wakeLock" in navigator)) {
      setState("unsupported");
      return;
    }

    let cancelled = false;

    async function acquire() {
      try {
        held.current = await navigator.wakeLock.request("screen");
        if (!cancelled) setState("held");
      } catch {
        // Denied, or the document was not visible. Not worth surfacing — the
        // recipe is still perfectly usable, the screen just dims.
        if (!cancelled) setState("idle");
      }
    }

    function onVisible() {
      if (document.visibilityState === "visible") void acquire();
    }

    void acquire();
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      void held.current?.release();
      held.current = null;
    };
  }, []);

  return state;
}
