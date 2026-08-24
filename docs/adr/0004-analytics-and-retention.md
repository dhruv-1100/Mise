# 0004 — Analytics: PostHog behind a sink, and retention cohorts defined before there is anyone in them

- **Status:** Accepted
- **Date:** 2026-08-24
- **Phase:** 6.3 (analytics)
- **Asked for by:** `BUILD_PLAN.md` §6.3 — "do not skip this" — and §1: "The
  number you cannot reconstruct later is retention. Instrument it in Phase 6,
  not Phase 11."

## Decision

1. **PostHog**, reached through an `AnalyticsSink` interface rather than called
   directly — the same arrangement as `LlmProvider` in the extractor, for the
   same reason.
2. **Seven typed events**, as a discriminated union. A typo is a compile error.
3. **No content in any property.** Ids, counts, booleans and durations only.
4. **Cohort definitions are written down here, now**, before there is a single
   user in one.

## Why the definitions come first

A retention number is not a measurement, it is a definition plus a measurement,
and the definition is the part people skip. "D7 retention is 24%" means nothing
until someone says which day is day zero, what counts as active, and whether day
7 means *on* day 7 or *by* day 7. Deciding that after seeing the data is how you
end up choosing the definition that flatters the number.

So:

| Term | Definition |
| --- | --- |
| **Day 0** | The UTC calendar date of the person's `signup` event. |
| **Cohort** | Everyone who signed up on the same day 0. |
| **Active** | Fired any of `recipe_extracted`, `recipe_viewed`, `recipe_saved`, `servings_changed`, `cook_mode_started`, `cook_mode_completed`. A `$pageview` alone is **not** active — a bounce off the home page is not retention. |
| **Cooking** | Fired `cook_mode_started`. The narrow, honest measure. |
| **D1 / D7 / D30** | Active on **exactly** that day, counted from day 0. Bounded, not "on or after". |
| **Activated** | Fired `recipe_extracted` at least once. A signup who never got a recipe is a funnel problem, not a retention problem, and mixing them hides both. |

**UTC, not local time.** Local-time day boundaries move when someone travels and
cannot be recomputed from stored events. UTC is arbitrary but stable, and stable
is the only property that matters for a cohort you will read in a year.

Two headline numbers get reported, always together:

- **D7 returning** — broad, comparable to what other products quote.
- **D7 cooking** — narrow, and the one that says whether this thing is useful.

Quoting only the first would be true and misleading. This project exists partly
to produce defensible numbers for a resume, and a number you cannot defend in
the follow-up question is worth less than no number.

## Identity stitching, which is the part that actually breaks

Someone lands, pastes a video, cooks it, and signs up two days later. Without an
explicit `identify()` at sign-in, those two days belong to an anonymous
distinct id, the account looks brand new, and D1 is quietly wrong forever.

So the sequence is fixed:

```
anonymous visit ──▶ posthog assigns distinct_id  (events attach to it)
       │
       └─▶ sign-in ──▶ identify(userId)  ──▶ $anon_distinct_id merges the history
                                              onto the person
```

`person_profiles: "identified_only"` — anonymous events are still captured and
still merge at identify; there is simply no person profile for a passer-by. This
is the cheaper option on a free tier and the more private one, and it costs
nothing that these cohorts need.

`signup` is the one event fired **server-side**, from Auth.js's `createUser`.
The browser cannot tell a new account from a returning sign-in — both are an
identical redirect — and Auth.js can, because it knows whether it just inserted
a row. Getting this wrong is not a small error: every cohort is anchored on it.

## What belongs here and what belongs in Prometheus

| Question | Tool |
| --- | --- |
| Did this person come back on day 7? | PostHog |
| How far do people scale recipes? | PostHog |
| What is p99 extraction latency? | Prometheus (Phase 7) |
| What fraction of extractions fail? | Prometheus |
| How long did *this person* wait before giving up? | PostHog (`recipe_extracted.waitedMs`) |

The split is by subject, not by data type: PostHog answers questions about
people, Prometheus answers questions about the system. `recipe_extracted` fires
from the browser on the SSE success frame rather than from the worker, because
the worker has no idea whose extraction it is — and the queue's own timings are
Phase 7's job.

## Deliberate omissions

- **Autocapture is off.** Seven named events are the question; every click on
  the page is noise, and on a free tier it is expensive noise.
- **Session recording is off**, and `mask_all_text` is on regardless. There is a
  notes field on this site. Recording someone typing a note about their dinner
  would be a genuinely bad thing to do.
- **`respect_dnt: true`**, which posthog-js does not default to. It costs a few
  percent of the numbers.
- **No content properties.** `CLAUDE.md` forbids persisting raw fetched text,
  and an analytics vendor is persistence like any other. Ingredient names,
  titles and note bodies never leave.

## Consequences

- `NEXT_PUBLIC_POSTHOG_KEY` unset means every sink is the no-op. The app is
  fully functional without analytics, and a missing environment variable can
  never be why a recipe page throws.
- Server-side captures are `await`ed and flushed with `flushAt: 1`. A serverless
  function stops executing the moment it responds, so a batched capture that
  flushes "soon" never flushes at all.
- These definitions are now load-bearing. Changing what "active" means later
  invalidates every historical cohort — so changing it means adding a second
  definition alongside, never editing this one.
