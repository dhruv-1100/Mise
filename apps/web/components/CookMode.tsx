"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";

import type { Recipe } from "@mise/schema";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { track } from "@/lib/analytics/client";
import { describeDuration, formatCountdown, formatDuration } from "@/lib/timer";
import { StepIngredients } from "@/components/StepIngredients";
import { scale } from "@mise/scaling";
import { useTimers } from "@/components/useTimers";

/**
 * Cook mode.
 *
 * The constraint that shaped the whole type scale: legible at arm's length, on
 * a counter, by someone with wet hands. 28px step text, an 18px floor, 44px
 * targets, inverted for glare.
 */
export function CookMode({
  recipe,
  signedIn,
  /**
   * The serving count chosen on the recipe page, carried in the URL.
   *
   * Cook mode is a separate route, so the stepper's state cannot reach it any
   * other way. A cook who scaled to 12 and then pressed Start cooking must not
   * be shown the 4-serving numbers, and a query parameter makes that survive a
   * reload and a shared link, which component state would not.
   */
  servings,
}: {
  recipe: Recipe;
  signedIn: boolean;
  servings: number | null;
}) {
  const router = useRouter();
  const [index, setIndex] = useState(0);
  const [finishing, setFinishing] = useState(false);
  const step = recipe.steps[index];
  const total = recipe.steps.length;

  const wakeLock = useWakeLock();
  const timers = useTimers();

  // The same engine the recipe page runs, on the same numbers — including the
  // sublinear seasoning rule. Anything else would put two different answers in
  // front of one cook.
  const scaled = useMemo(() => {
    const target = servings ?? recipe.yield?.qty ?? null;
    if (target === null) return null;
    const result = scale(recipe, target);
    return result.ok ? result.value : null;
  }, [recipe, servings]);

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

        {/* Below the step, above the timers — the spec's ordering, and the
            right one: the instruction is what you came back to read, the
            quantities are what you check against it, and a timer you started
            two minutes ago should not push either of them down. */}
        <StepIngredients
          items={scaled?.ingredients ?? []}
          all={scaled?.ingredients ?? []}
          servings={servings ?? recipe.yield?.qty ?? null}
          /* `step.uses` does not exist in the schema yet, so every step gets
             the full list. The spec explicitly permits this fallback and says
             not to block on it. */
          precise={false}
        />

        {(step.durationS !== null || step.tempC !== null) && (
          <div className="mt-6 flex flex-wrap gap-3">
            {step.durationS !== null && (
              <StepTimer
                durationS={step.durationS}
                remaining={timers.remaining(index)}
                onStart={() => timers.start(index, step.durationS!)}
                onCancel={() => timers.cancel(index)}
              />
            )}
            {step.tempC !== null && (
              <span className="rounded-lg bg-cook-surface px-5 py-4 text-xl font-semibold tabular-nums">
                {step.tempC}°C
              </span>
            )}
          </div>
        )}

        {/* Timers belonging to OTHER steps. Without this, starting a 20-minute
            simmer and moving on hides the only thing you need to see. */}
        <OtherTimers timers={timers} currentStep={index} />
      </div>

      {timers.justRang !== null && (
        <TimerFinished
          durationS={timers.justRang.durationS}
          stepNumber={timers.justRang.stepIndex + 1}
          onDismiss={timers.dismiss}
        />
      )}

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


/**
 * The duration on a step, as a control rather than a label.
 *
 * BUILD_PLAN.md §6.1 asked for inline timers and the step already carries
 * `durationS`; until now it was printed as text. Tapping it is the difference
 * between a recipe viewer and something you cook from.
 */
function StepTimer({
  durationS,
  remaining,
  onStart,
  onCancel,
}: {
  durationS: number;
  remaining: number | null;
  onStart: () => void;
  onCancel: () => void;
}) {
  if (remaining === null) {
    return (
      <button
        type="button"
        onClick={onStart}
        className="flex min-h-[60px] items-center gap-2.5 rounded-lg bg-cook-surface px-5 py-4 text-xl font-semibold tabular-nums"
      >
        <span aria-hidden="true">⏱</span>
        {formatDuration(durationS)}
        <span className="text-[13px] font-semibold uppercase tracking-[0.08em] text-cook-ink-soft">
          start
        </span>
      </button>
    );
  }

  const done = remaining === 0;
  return (
    <button
      type="button"
      onClick={onCancel}
      aria-label={done ? "Timer finished, dismiss" : `${formatCountdown(remaining)} remaining, cancel timer`}
      className={`flex min-h-[60px] items-center gap-3 rounded-lg px-5 py-4 text-xl font-bold tabular-nums ${
        done ? "bg-accent text-ground" : "bg-cook-surface text-cook-ink"
      }`}
    >
      {/* aria-hidden because the button's own label already says it: without
          this a screen reader announces the countdown twice, once per second. */}
      <span aria-hidden="true">{done ? "Time's up" : formatCountdown(remaining)}</span>
      <span className="text-[13px] font-semibold uppercase tracking-[0.08em] opacity-70">
        {done ? "dismiss" : "cancel"}
      </span>
    </button>
  );
}

/**
 * Timers started on steps you are no longer looking at.
 *
 * The reason timers live above the step: you start a twenty-minute simmer and
 * move on to the next thing, which is exactly when you most need to see it.
 */
function OtherTimers({
  timers,
  currentStep,
}: {
  timers: ReturnType<typeof useTimers>;
  currentStep: number;
}) {
  const others = Object.values(timers.timers).filter((t) => t.stepIndex !== currentStep);
  if (others.length === 0) return null;

  return (
    <ul className="mt-6 flex flex-col gap-2">
      {others.map((t) => {
        const left = timers.remaining(t.stepIndex) ?? 0;
        return (
          <li
            key={t.stepIndex}
            className="flex items-center justify-between gap-3 rounded-lg bg-cook-surface px-4 py-3"
          >
            <span className="text-[15px] text-cook-ink-soft">Step {t.stepIndex + 1}</span>
            <span className="flex items-center gap-3">
              <span className={`text-lg font-bold tabular-nums ${left === 0 ? "text-accent" : ""}`}>
                {left === 0 ? "Time's up" : formatCountdown(left)}
              </span>
              <button
                type="button"
                onClick={() => timers.cancel(t.stepIndex)}
                aria-label={`Cancel the timer on step ${t.stepIndex + 1}`}
                className="flex size-11 items-center justify-center rounded-md text-cook-ink-soft"
              >
                ✕
              </button>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The visual half of the alarm.
 *
 * The one alert that always works. Vibration needs a motor and audio needs a
 * prior gesture and an unmuted device; neither is guaranteed in a kitchen, so
 * nothing depends on them.
 *
 * role="alertdialog" rather than a toast: a finished timer is the one thing in
 * this app worth interrupting for, and it should survive the person not having
 * looked at the screen for twenty minutes.
 */
function TimerFinished({
  durationS,
  stepNumber,
  onDismiss,
}: {
  durationS: number;
  stepNumber: number;
  onDismiss: () => void;
}) {
  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="timer-finished"
      className="fixed inset-x-0 bottom-0 z-10 border-t border-cook-surface bg-accent px-5 pb-9 pt-6 text-ground"
    >
      <p id="timer-finished" className="text-2xl font-bold">
        {describeDuration(durationS)} up
      </p>
      <p className="mt-1 text-base opacity-80">Step {stepNumber}</p>
      <button
        type="button"
        onClick={onDismiss}
        autoFocus
        className="mt-5 h-[60px] w-full rounded-md bg-ground text-lg font-bold text-ink"
      >
        Stop
      </button>
    </div>
  );
}
