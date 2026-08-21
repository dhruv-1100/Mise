"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

/** Messages for the codes the BFF can return. Never a raw error string. */
const MESSAGES: Record<string, string> = {
  not_a_youtube_url: "That is not a YouTube link. Paste a youtube.com or youtu.be address.",
  video_not_found: "We could not find that video. It may be private or removed.",
  quota_exceeded: "We are over today's YouTube quota. It resets at midnight Pacific.",
  queue_full: "We are busy right now. Your place is not lost — try again shortly.",
  unavailable: "The extraction service is not responding. Try again in a moment.",
  bad_request: "Paste a YouTube link to get started.",
};

export function UrlForm() {
  const router = useRouter();
  const [video, setVideo] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (busy || video.trim().length === 0) return;
    setBusy(true);
    setError(null);

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
        className="flex items-center gap-2.5 rounded-lg border border-line bg-surface py-1.5 pl-4 pr-1.5 shadow-sm"
      >
        <label htmlFor="video" className="sr-only">
          YouTube video URL
        </label>
        <input
          id="video"
          name="video"
          type="url"
          inputMode="url"
          autoComplete="off"
          placeholder="youtube.com/watch?v=…"
          value={video}
          onChange={(e) => setVideo(e.target.value)}
          aria-invalid={error !== null}
          aria-describedby={error === null ? undefined : "video-error"}
          className="min-w-0 flex-1 bg-transparent text-base text-ink outline-none placeholder:text-ink-faint"
        />
        <button
          type="submit"
          disabled={busy}
          /* 44px minimum target — the design's rule, not a suggestion. */
          className="flex h-11 min-w-11 items-center gap-2 rounded-md bg-accent px-[18px] text-[15px] font-semibold text-ground disabled:opacity-60"
        >
          {busy ? "Working…" : "Extract"}
        </button>
      </form>

      {error !== null && (
        /* assertive: the person just acted and is waiting on the answer. */
        <p
          id="video-error"
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
