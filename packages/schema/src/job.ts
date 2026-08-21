/**
 * Extraction job status.
 *
 * Extraction takes 10-40 seconds, so it cannot be a synchronous request
 * (BUILD_PLAN.md §4). The BFF enqueues, then streams this object to the browser
 * over SSE until it reaches a terminal state.
 *
 * The stage names are deliberately user-facing. The plan asks for "live status,
 * not a spinner. Show stage names." — so `stage` is part of the contract rather
 * than an internal detail, and the Phase 5 progress screen renders it directly.
 */

import { z } from "zod";

import { VideoId } from "./recipe";

export const JobState = z.enum([
  /** Accepted and waiting for a worker. */
  "queued",
  /** A worker holds it. `stage` says where it is. */
  "running",
  /** Finished; the recipe is retrievable. */
  "succeeded",
  /** Gave up after exhausting retries. `error` says why. */
  "failed",
]);
export type JobState = z.infer<typeof JobState>;

/** Pipeline stages, in order. Shown to the user while they wait. */
export const JobStage = z.enum(["fetching", "normalizing", "extracting", "canonicalising"]);
export type JobStage = z.infer<typeof JobStage>;

export const JobError = z
  .object({
    /** Stable machine-readable code, matching the extractor's error envelope. */
    code: z.string().trim().min(1),
    message: z.string().trim().min(1),
  })
  .strict();
export type JobError = z.infer<typeof JobError>;

export const Job = z
  .object({
    jobId: z.string().trim().min(1),
    videoId: VideoId,
    state: JobState,
    /**
     * Completed attempts. 0 while first queued, so a job on its second try
     * reads `attempt: 1`.
     */
    attempt: z.number().int().min(0),

    queuedAt: z.iso.datetime(),
    startedAt: z.iso.datetime().nullable(),
    finishedAt: z.iso.datetime().nullable(),

    stage: JobStage.nullable(),
    error: JobError.nullable(),

    /**
     * Served from cache without re-extracting. A video extracted once is never
     * extracted again (BUILD_PLAN.md §4), and cache hit rate is a Phase 7
     * metric — which is unmeasurable if the response does not say.
     */
    cached: z.boolean(),
  })
  .strict()
  .superRefine((job, ctx) => {
    // A failed job with no error is unactionable: the UI has nothing to show
    // and the operator has nothing to debug.
    if (job.state === "failed" && job.error === null) {
      ctx.addIssue({
        code: "custom",
        message: "a failed job must carry an error",
        path: ["error"],
      });
    }
    if (job.state !== "failed" && job.error !== null) {
      ctx.addIssue({
        code: "custom",
        message: `state "${job.state}" must not carry an error`,
        path: ["error"],
      });
    }
    // Running means a worker picked it up, which is what startedAt records.
    if (job.state === "running" && job.startedAt === null) {
      ctx.addIssue({
        code: "custom",
        message: "a running job must have startedAt",
        path: ["startedAt"],
      });
    }
    if ((job.state === "succeeded" || job.state === "failed") && job.finishedAt === null) {
      ctx.addIssue({
        code: "custom",
        message: `state "${job.state}" is terminal and must have finishedAt`,
        path: ["finishedAt"],
      });
    }
    // A stage is a position inside the work, so it only means something while
    // the work is happening.
    if (job.state !== "running" && job.stage !== null) {
      ctx.addIssue({
        code: "custom",
        message: `state "${job.state}" must not carry a stage`,
        path: ["stage"],
      });
    }
  });
export type Job = z.infer<typeof Job>;
