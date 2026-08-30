"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { track } from "@/lib/analytics/client";

/** Stage order and the words a person sees. Not the enum names. */
const STAGES = [
  { key: "JOB_STAGE_FETCHING", label: "Fetching the description" },
  { key: "JOB_STAGE_NORMALIZING", label: "Stripping links and sponsor reads" },
  { key: "JOB_STAGE_EXTRACTING", label: "Reading the recipe" },
  // Only reached when the description carried no recipe (ADR 0006), and it
  // takes tens of seconds rather than the few the others take. Said out loud
  // because a progress screen that sits silently that long reads as stuck.
  { key: "JOB_STAGE_WATCHING", label: "No recipe written down — watching the video" },
  { key: "JOB_STAGE_CANONICALISING", label: "Converting to grams and millilitres" },
] as const;

const FAILURE: Record<string, string> = {
  llm_unavailable: "The model was unavailable each time we tried.",
  quota_exceeded: "We ran out of YouTube quota partway through.",
  upstream_error: "YouTube did not respond.",
  internal_error: "Something went wrong on our side.",
};

interface JobShape {
  jobId: string;
  videoId: string;
  state: string | number;
  stage: string | number;
  attempt: number;
  error?: { code: string; message: string } | undefined;
}

function name(v: string | number, enumName: "state" | "stage"): string {
  if (typeof v === "string") return v;
  const states = ["JOB_STATE_UNSPECIFIED", "JOB_STATE_QUEUED", "JOB_STATE_RUNNING",
    "JOB_STATE_SUCCEEDED", "JOB_STATE_FAILED"];
  // Index order must match the proto's field numbers, not the display order
  // above: WATCHING is 5 and CANONICALISING is 4, because the stage was added
  // to the enum after it. Reordering this array to read nicely would silently
  // mislabel every stage past the third.
  const stages = ["JOB_STAGE_UNSPECIFIED", "JOB_STAGE_FETCHING", "JOB_STAGE_NORMALIZING",
    "JOB_STAGE_EXTRACTING", "JOB_STAGE_CANONICALISING", "JOB_STAGE_WATCHING"];
  return (enumName === "state" ? states : stages)[v] ?? "";
}

export function JobProgress({ jobId }: { jobId: string }) {
  const router = useRouter();
  const [job, setJob] = useState<JobShape | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  // How long someone actually stared at this screen. The interesting half of
  // the extraction latency story — the queue's own timings are Prometheus's
  // job in Phase 7, but this is the number that decides whether they stay.
  const startedAt = useRef(Date.now());

  useEffect(() => {
    const source = new EventSource(`/api/jobs/${jobId}/events`);

    source.addEventListener("status", (event) => {
      const next = JSON.parse((event as MessageEvent).data) as JobShape;
      setJob(next);
      if (name(next.state, "state") === "JOB_STATE_SUCCEEDED") {
        source.close();
        track({
          name: "recipe_extracted",
          properties: {
            videoId: next.videoId,
            cached: false,
            waitedMs: Date.now() - startedAt.current,
          },
        });
        router.push(`/r/${next.videoId}`);
      }
      if (name(next.state, "state") === "JOB_STATE_FAILED") {
        source.close();
        setFailed(next.error?.code ?? "internal_error");
      }
    });

    source.addEventListener("error", (event) => {
      // A named error event carries a payload; a bare one is a dropped
      // connection, which EventSource retries on its own.
      const data = (event as MessageEvent).data;
      if (typeof data === "string") {
        source.close();
        setFailed(JSON.parse(data).error ?? "internal_error");
      }
    });

    return () => source.close();
  }, [jobId, router]);

  const current = job === null ? "" : name(job.stage, "stage");
  const reached = STAGES.findIndex((s) => s.key === current);

  if (failed !== null) {
    return (
      <div role="alert" className="rounded-lg border border-line bg-surface p-6">
        <h2 className="text-lg font-semibold">We could not finish this one</h2>
        <p className="mt-2 text-sm leading-relaxed text-ink-soft">
          {FAILURE[failed] ?? "Extraction failed."} The job is kept, so it can be retried once
          the service recovers.
        </p>
        <Link
          href="/"
          className="mt-4 inline-flex h-11 items-center rounded-md border border-line px-4 text-sm font-semibold"
        >
          Try another video
        </Link>
      </div>
    );
  }

  return (
    <div>
      {/* One live region for the whole list: announcing each stage separately
          would interrupt a screen-reader user four times in twenty seconds. */}
      <ol className="flex flex-col gap-5" aria-live="polite" aria-busy={failed === null}>
        {STAGES.map((stage, i) => {
          const done = reached > i;
          const active = reached === i;
          return (
            <li key={stage.key} className="flex items-start gap-3.5">
              <span
                aria-hidden="true"
                className={
                  done
                    ? "flex size-[26px] flex-none items-center justify-center rounded-full bg-herb text-ground"
                    : active
                      ? "flex size-[26px] flex-none items-center justify-center rounded-full border-2 border-accent"
                      : "size-[26px] flex-none rounded-full border-2 border-line"
                }
              >
                {done ? "✓" : active ? <span className="size-2.5 rounded-full bg-accent" /> : null}
              </span>
              <span
                className={
                  active
                    ? "text-base font-semibold text-ink"
                    : done
                      ? "text-base text-ink-soft"
                      : "text-base text-ink-faint"
                }
              >
                {stage.label}
                <span className="sr-only">{done ? " — done" : active ? " — in progress" : ""}</span>
              </span>
            </li>
          );
        })}
      </ol>
      <p className="mt-8 text-[13px] leading-relaxed text-ink-faint">
        Stage names rather than a spinner, because a spinner tells you nothing when a step is
        slow. You can leave this page; the job keeps running.
      </p>
    </div>
  );
}
