"use client";

import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";

import { track } from "@/lib/analytics/client";

/** Messages for the codes the BFF can return. Never a raw error string. */
const MESSAGES: Record<string, string> = {
  not_a_youtube_url: "That is not a YouTube link. Paste a youtube.com or youtu.be address.",
  video_not_found: "We could not find that video. It may be private or removed.",
  quota_exceeded: "We are over today's YouTube quota. It resets at midnight Pacific.",
  queue_full: "We are busy right now. Your place is not lost — try again shortly.",
  unavailable: "The extraction service is not responding. Try again in a moment.",
  bad_request: "Paste a YouTube link to get started.",
};

export function UrlForm({
  /**
   * The header's version: shorter, quieter, and no error text below it.
   *
   * Same component rather than a second one, because the thing that is hard
   * about this form is the submit path — the error codes, the cached-video
   * redirect, the busy state — and having two copies of that is how one of
   * them drifts. Only the chrome differs.
   */
  compact = false,
}: {
  compact?: boolean;
} = {}) {
  const router = useRouter();
  // Unique per instance. The header and the home hero are the same component,
  // and a hardcoded id would collide the moment both render — silently breaking
  // the label association rather than erroring.
  const fieldId = useId();
  const [video, setVideo] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (busy || video.trim().length === 0) return;
    setBusy(true);
    setError(null);
    const startedAt = Date.now();

    try {
      const res = await fetch("/api/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ video }),
      });
      const body = await res.json();

      if (!res.ok) {
        setError(MESSAGES[body.error] ?? "Something went wrong. Try again.");
        setBusy(false);
        return;
      }
      // A cached video is already done, so skip the progress screen entirely.
      // It still counts as an extraction from the person's point of view —
      // they asked for a recipe and got one — and `cached` is what keeps the
      // two apart in the latency numbers.
      if (body.job.cached) {
        track({
          name: "recipe_extracted",
          properties: {
            videoId: body.job.videoId,
            cached: true,
            waitedMs: Date.now() - startedAt,
          },
        });
      }
      router.push(body.job.cached ? `/r/${body.job.videoId}` : `/j/${body.job.jobId}`);
    } catch {
      setError("We could not reach the server. Check your connection.");
      setBusy(false);
    }
  }

  return (
    <div>
      <form
        onSubmit={onSubmit}
        className={
          compact
            ? "flex h-10 items-center gap-2 rounded-md border border-line bg-ground px-3"
            : "flex items-center gap-2.5 rounded-lg border border-line bg-surface py-1.5 pl-4 pr-1.5 shadow-sm"
        }
      >
        <label htmlFor={fieldId} className="sr-only">
          YouTube video URL
        </label>
        <input
          id={fieldId}
          name="video"
          type="url"
          inputMode="url"
          autoComplete="off"
          placeholder="youtube.com/watch?v=…"
          value={video}
          onChange={(e) => setVideo(e.target.value)}
          aria-invalid={error !== null}
          aria-describedby={error === null ? undefined : `${fieldId}-error`}
          className={`min-w-0 flex-1 bg-transparent text-ink outline-none placeholder:text-ink-faint ${
            compact ? "text-sm" : "text-base"
          }`}
        />
        <button
          type="submit"
          disabled={busy}
          /* 44px minimum target — the design's rule, not a suggestion. */
          className={
            compact
              ? "flex h-8 items-center rounded-[5px] bg-accent px-3 text-[13px] font-semibold text-ground disabled:opacity-60"
              : "flex h-11 min-w-11 items-center gap-2 rounded-md bg-accent px-[18px] text-[15px] font-semibold text-ground disabled:opacity-60"
          }
        >
          {busy ? "Working…" : "Extract"}
        </button>
      </form>

      {error !== null && (
        /* assertive: the person just acted and is waiting on the answer. */
        <p
          id={`${fieldId}-error`}
          role="alert"
          aria-live="assertive"
          className="mt-3 text-sm leading-relaxed text-warn-text"
        >
          {error}
        </p>
      )}
    </div>
  );
}
