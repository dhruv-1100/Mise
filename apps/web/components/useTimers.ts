"use client";

import { useCallback, useEffect, useState } from "react";

import { hasExpired, remainingSeconds } from "@/lib/timer";

export interface RunningTimer {
  /** Which step started it. Timers outlive the step you are looking at. */
  stepIndex: number;
  /** Absolute wall-clock end. Never a countdown — see lib/timer.ts. */
  endsAt: number;
  durationS: number;
  rang: boolean;
}

/**
 * Cook-mode timers.
 *
 * Several at once, on purpose: rice simmers while onions fry, and a timer that
 * cancelled itself when you advanced a step would be useless for the one case
 * that matters. State lives here, above the step being displayed, so moving
 * between steps does not touch a running timer.
 *
 * ONE interval drives all of them. A `setInterval` per timer would multiply the
 * wake-ups for no benefit — nothing is being decremented, the tick only asks
 * the render to recompute from `Date.now()`.
 */
export function useTimers() {
  const [timers, setTimers] = useState<Record<number, RunningTimer>>({});
  const [now, setNow] = useState(() => Date.now());
  const [justRang, setJustRang] = useState<RunningTimer | null>(null);

  const active = Object.values(timers).some((t) => !t.rang);

  useEffect(() => {
    if (!active) return;
    // 250ms rather than 1000: the seconds digit changes on a boundary the tick
    // does not know about, and a 1s tick lands visibly late about half the time.
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [active]);

  // Ringing is a side effect of time passing, so it belongs here rather than in
  // the tick: `now` also changes when the tab wakes after being throttled, and
  // a timer that expired while nobody was looking must still ring on return.
  useEffect(() => {
    const expired = Object.values(timers).find((t) => !t.rang && hasExpired(t.endsAt, now));
    if (expired === undefined) return;

    setTimers((prev) => ({ ...prev, [expired.stepIndex]: { ...expired, rang: true } }));
    setJustRang(expired);
    alarm();
  }, [now, timers]);

  const start = useCallback((stepIndex: number, durationS: number) => {
    setTimers((prev) => ({
      ...prev,
      [stepIndex]: { stepIndex, endsAt: Date.now() + durationS * 1000, durationS, rang: false },
    }));
    setNow(Date.now());
  }, []);

  const cancel = useCallback((stepIndex: number) => {
    setTimers((prev) => {
      const next = { ...prev };
      delete next[stepIndex];
      return next;
    });
    setJustRang((r) => (r?.stepIndex === stepIndex ? null : r));
  }, []);

  const dismiss = useCallback(() => {
    setJustRang((r) => {
      if (r !== null) cancel(r.stepIndex);
      return null;
    });
  }, [cancel]);

  const remaining = useCallback(
    (stepIndex: number): number | null => {
      const t = timers[stepIndex];
      return t === undefined ? null : remainingSeconds(t.endsAt, now);
    },
    [timers, now],
  );

  return { timers, remaining, start, cancel, justRang, dismiss, now };
}

/**
 * Ring.
 *
 * Vibration first — it is the one that works with the phone face-down on a
 * counter — then a tone. The tone is synthesised rather than an audio file:
 * cook mode is the page most likely to be open on bad kitchen wifi, and a timer
 * whose alarm is a network request is a timer that silently does not ring.
 *
 * Everything here is best-effort. A browser that blocks audio before a gesture,
 * or has no vibration motor, must not throw — the visual alert is the one that
 * always works and it is not in this function.
 */
function alarm(): void {
  try {
    navigator.vibrate?.([300, 150, 300, 150, 500]);
  } catch {
    // No motor, or a policy against it. The visual alert stands.
  }

  try {
    const Ctor = window.AudioContext ?? window.webkitAudioContext;
    if (Ctor === undefined) return;
    const ctx = new Ctor();

    // Three short beeps. A continuous tone reads as an error sound; this reads
    // as a kitchen timer.
    for (let i = 0; i < 3; i++) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = 880;
      const at = ctx.currentTime + i * 0.28;
      // Ramped rather than switched: an abrupt gain change is an audible click.
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.35, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.22);
      osc.connect(gain).connect(ctx.destination);
      osc.start(at);
      osc.stop(at + 0.24);
    }
    window.setTimeout(() => void ctx.close(), 1200);
  } catch {
    // Autoplay policy, or no Web Audio. Silent is acceptable; crashing is not.
  }
}
