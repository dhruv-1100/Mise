"use client";

import Link from "next/link";
import { useState } from "react";

import { track } from "@/lib/analytics/client";

/**
 * Save a recipe.
 *
 * Optimistic, and honest about it: the button flips immediately and flips back
 * if the request fails. Waiting for a round trip to acknowledge a toggle is the
 * kind of latency people read as "it didn't work" and tap again.
 *
 * Signed out, this is a link rather than a disabled button — the answer to
 * "can I save this" is "yes, sign in", not silence.
 */
export function SaveButton({
  videoId,
  initialSaved,
  signedIn,
}: {
  videoId: string;
  initialSaved: boolean;
  signedIn: boolean;
}) {
  const [saved, setSaved] = useState(initialSaved);
  const [busy, setBusy] = useState(false);

  if (!signedIn) {
    return (
      <Link
        href={`/signin?next=/r/${videoId}`}
        className="flex h-11 items-center justify-center rounded-md border border-line px-4 text-[15px] font-semibold text-ink-soft"
      >
        Save
      </Link>
    );
  }

  async function toggle() {
    if (busy) return;
    const wanted = !saved;
    setSaved(wanted);
    setBusy(true);

    try {
      const res = await fetch(`/api/recipes/${videoId}/save`, {
        method: wanted ? "POST" : "DELETE",
      });
      if (!res.ok) {
        setSaved(!wanted);
        return;
      }
      // Fired on the acknowledgement, not the optimistic flip: the button lies
      // for a moment on purpose, and the metric must not.
      track({ name: "recipe_saved", properties: { videoId, saved: wanted } });
    } catch {
      setSaved(!wanted);
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={saved}
      className={`flex h-11 items-center justify-center rounded-md px-4 text-[15px] font-semibold ${
        saved ? "bg-accent-wash text-accent-deep" : "border border-line text-ink-soft"
      }`}
    >
      {saved ? "Saved" : "Save"}
    </button>
  );
}
