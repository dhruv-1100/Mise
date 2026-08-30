# 0006 — Watching the video when the description has no recipe

- **Status:** Accepted
- **Date:** 2026-08-28
- **Phase:** 2.3 (extraction pipeline), closing the dead end ADR 0001 opened
- **Builds on:** ADR 0001 (content sourcing), ADR 0002 (LLM provider)

## Decision

When description extraction returns `insufficient_source_material`, hand the
**YouTube URL directly to Gemini** and ask the model to watch the video. Second,
never first. Best-effort, never fatal. Everything it produces is marked
`source: "video"`.

## Context

ADR 0001 established the constraint the whole project is shaped around:
`captions.download` returns 401 without the creator's OAuth, so descriptions are
the primary source. It also measured the cost of that: **roughly one description
in five carries no usable recipe**, because the creator deliberately keeps it on
their own site.

Until now that was where the product stopped. A reader pasted a video, watched
three progress stages complete, and got a page explaining there was no recipe —
for a video that plainly contains one, with the ingredients on screen. That is
the single largest gap between "this works" and "this is useful".

## Is this routing around the guardrail?

CLAUDE.md is explicit: official YouTube Data API only, and a limit is "a finding
to document in an ADR, not an obstacle to route around." So this question has to
be answered rather than assumed.

**BUILD_PLAN §2.1 anticipated exactly this fallback.** Its instruction, if
captions are blocked, is to pivot to creator-permissioned OAuth *or* "fall back
to audio transcription you run yourself (Whisper on the audio track) — which has
its own ToS considerations, so document the decision in an ADR."

This is a strictly cleaner version of that fallback. Nothing is downloaded, no
audio is extracted, no scraper exists anywhere in the path. A URL is handed to a
first-party Google API, and Google reads a video already hosted on Google's own
platform. The guardrail's target — `yt-dlp`, transcript scrapers, anything that
pulls media off YouTube's servers — is untouched, and the CI check that enforces
it still passes unchanged.

**The tension, stated plainly rather than glossed:** YouTube gates
`captions.download` behind creator OAuth, and this obtains substantially the same
content — what is said in the video — without that permission. That Google offers
both surfaces is Google's business and not a contradiction this project created,
and the legal posture holds: no copy is made, nothing is redistributed,
attribution and the embedded player are unchanged, and no raw transcript is
persisted. But it is a real shift from "descriptions are primary because captions
are gated", and it should be a decision on the record rather than a drift.

Two things do **not** change, and are worth restating because this is where they
would erode: raw fetched text is still never persisted, and the model's output is
still structured extraction rather than a transcript.

## Measured, not estimated

`scripts/spike_video.py` ran before any of this was designed, against the video
that surfaced the problem — a video whose description is link-only:

| | Description path | Video path |
| --- | --- | --- |
| Input tokens | ~1,000 | **54,659** |
| Wall clock | ~2s | **~28s** |
| Result | nothing | 17 ingredients, 15 steps |
| Quantities left `null` | — | **4 of 17** |

That last row is the one that mattered. The rule this project cares about most
is never inventing a quantity, and speech is where the pressure to invent is
highest — people say "a good glug of oil" far more often than they write it. The
model left "a few drops", "1 pinch" and "for garnish" as vague text rather than
guessing numbers. Had it come back with 17 of 17 confidently numbered, that would
have been evidence to reject this, not to ship it.

**~50× the input tokens** is why this is a fallback and not the default. The
cheap path runs for every video; this runs only where the cheap path came back
empty-handed, which ADR 0001 puts at about one in five.

## Best-effort, never fatal

The first implementation let a failure in the video call propagate. Four existing
tests went red and were right to: at the point the fallback runs, the description
stage has **already produced a correct, complete answer** — "there is no recipe
in this description". Letting the optional second attempt fail the whole
extraction discards that, so a quota limit or a saturated model turns a working
result into a retry loop.

`LlmError` from the fallback is now logged and swallowed. The fallback can only
ever add.

For the same reason, a video extraction that also finds nothing does not replace
the description's reason with its own. "Not a recipe video" is a worse and less
accurate explanation than "the description is only links", and the no-recipe page
shows that reason to the reader verbatim.

## Provenance, and why video is discounted

`SourceKind` gains `video`, alongside `description`, `caption`, `title` and
`manual`. Every ingredient and step the fallback produces carries it, so the
Phase 2.2 eval can score the two paths separately — they will not have the same
accuracy and reporting one number across both would hide that.

Video-sourced ingredients get lower confidence than description-sourced ones
(0.75 vs 0.9 with a stated quantity, 0.5 vs 0.6 without). A written "200g" is the
creator's considered figure; the same number heard once in speech may be an aside
or a mishearing. These are priors, not measurements — the eval set is what turns
them into the latter, and they should be recalibrated the day it exists.

This lines up with BUILD_PLAN §2.3's resolution rule — *prefer description for
quantities, transcript for technique* — and the `Conflict` type already in the
schema is the machinery for applying it. Today the fallback only runs when the
description produced **nothing**, so the two never disagree and no conflict can
arise. Merging a partial description with video-sourced steps is the obvious next
move and is deliberately not in this change.

## Consequences

- **A new job stage.** `JOB_STAGE_WATCHING` exists because the step takes tens of
  seconds, and a progress screen that sat silently on "extracting" for half a
  minute reads as stuck rather than busy. The reader is told the description had
  nothing and the video is being watched.
- **Cost per extraction is no longer uniform.** Phase 7's metric must report the
  two paths separately or the average will describe neither. Both calls are
  counted in `PipelineStats`.
- **Latency**: about 28s added for the one-in-five that need it, on top of the
  91.5s already measured in production. The 60s target in `docs/METRICS.md` was
  already being missed and this widens the gap for that slice.
- **Quota**: YouTube-URL video processing has its own daily limits, tighter on
  the free tier. Nothing currently degrades gracefully when they are hit beyond
  the best-effort swallow above. Worth a real budget check in Phase 8.
- **`watch_video=False`** turns the whole thing off at the pipeline boundary, so
  the eval harness can measure the description path in isolation.
