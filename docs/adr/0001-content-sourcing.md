# 0001 — Content sourcing: where recipe text comes from

- **Status:** Accepted
- **Date:** 2026-08-17
- **Phase:** 2.1 (go/no-go)
- **Evidence:** `scripts/spike_captions.py`, run against 5 videos from 5 creators.
  Raw output in `scripts/spike_output/` (gitignored).

## Verdict

**Go — but not on captions.**

Captions are unreachable without OAuth, and the block is harder than expected.
Descriptions turned out to be far richer than the build plan assumed. The
primary content source flips from captions to descriptions; captions become an
optional enrichment gated behind creator permission.

## Context

`BUILD_PLAN.md` §2.1 called this the highest-risk unknown in the project and
predicted `captions.download` would return **403** without the video owner's
OAuth. Four questions were tested empirically before any product code was
written.

Sample: 5 videos, 5 distinct creators. Skewed — four are Indian home-cooking
channels and one is a coffee-technique channel. **n=5 supports direction, not
percentages.**

| Video | Creator | Duration |
| --- | --- | --- |
| `bUounn_Bmy4` | Your Food Lab (Sanjyot Keer) | 7m31s |
| `j3pDXY9fqSo` | Chef Ranveer Brar | 8m00s |
| `sAnPUIvPc1I` | CookingShooking Hindi | 10m44s |
| `cRsAQeR5dbI` | Hebbars Kitchen | 2m20s |
| `j6VlT_jUVPc` | James Hoffmann | 5m13s |

## Findings

### Q1 — `captions.list` works with a plain API key. Yes.

5/5 calls returned HTTP 200. 4/5 videos listed at least one track. **Listing
caption metadata is public; retrieving caption content is not.** These are
governed by completely different auth rules, which is easy to miss.

### Q2 — `captions.download` is blocked, but with 401, not 403.

0/6 track downloads succeeded. Every one returned:

```
HTTP 401  reason: required
"API keys are not supported by this API. Expected OAuth2 access token or
 other authentication credentials that assert a principal."
```

**This is a stronger block than the predicted 403, and the distinction matters
architecturally.** A 403 would mean "you are authenticated but not authorized
for this resource" — implying the request reached an ownership check and that
the right OAuth token would pass it. A 401 of this form means the endpoint
refuses API-key authentication *categorically*, before any ownership question is
asked. We never reached the ownership check at all.

**Honest limitation of this spike:** it proves API keys can never work. It does
**not** prove that owner OAuth *does* work, nor measure what a non-owner OAuth
token gets. Those are untested. The next experiment, if captions ever become
worth pursuing, is to present an OAuth token for a video we do not own and see
whether the 401 becomes a 403 — that is the test that confirms the block is
about ownership rather than about something else.

### Q3 — Auto-generated captions are not more accessible. No difference.

3 ASR tracks and 3 manually-uploaded `standard` tracks were tested individually.
Both classes returned **identical** `401 required`. Every track reported
`status: serving`, `isDraft: false` — that is, fully published and live — and
still refused to download.

This kills a tempting assumption: that auto-generated captions, being
machine-produced rather than creator-authored, might be treated as public data.
They are not. They are gated exactly like manual ones.

### Q4 — Descriptions carry far more of the recipe than the plan assumed.

| Video | Creator | Verdict | Ingredients w/ qty | Steps |
| --- | --- | --- | --- | --- |
| `bUounn_Bmy4` | Your Food Lab | FULL_RECIPE | 32 | 9 |
| `j3pDXY9fqSo` | Ranveer Brar | FULL_RECIPE | 22 | 9 |
| `j6VlT_jUVPc` | James Hoffmann | FULL_RECIPE | 2 | 6 |
| `sAnPUIvPc1I` | CookingShooking | INGREDIENTS_ONLY | 23 | 0 |
| `cRsAQeR5dbI` | Hebbars Kitchen | NONE | 0 | 0 |

**3/5 descriptions contain a complete recipe** — ingredients with quantities and
a full method. **4/5 contain a usable ingredient list.** All five raw
descriptions were read manually; the table above matches manual assessment on
all five.

The one failure is instructive rather than random: Hebbars Kitchen's description
is a link to their own website plus SEO prose. That is a deliberate business
decision — they monetize their own site — and it is exactly the creator profile
where a description-first approach will not work.

**Methodology caveat, recorded because it nearly produced the wrong decision:**
the heuristic's first version scored these descriptions 1/5 usable. It anchored
quantities to the start of a line and counted only numbered steps. Real creators
write `Oil - 1 tbsp` and `TOMATO | टमाटर 4 NOS.` — quantity last — and write
steps as bullets or bare prose. Manual reading of the raw text caught the error.
The corrected heuristic now agrees with manual labels 5/5, but it was **tuned
against these same 5 videos**, so that agreement is not evidence of
generalization. Treat it as triage, not measurement. The real number comes from
the Phase 2.2 hand-labelled 50-video set.

### Incidental finding — `contentDetails.caption` is unreliable

`videos.list` reports a boolean claim about whether a video has captions. It
disagreed with `captions.list` on 1 of 5 videos: `cRsAQeR5dbI` claims `caption:
false` yet lists an ASR track (in Korean, for a Hindi/English video — evidently
noise). Do not use this field as a cheap pre-filter; it is not authoritative.

### Quota economics push the same direction

| Call | Units | Videos/day at 10,000-unit default |
| --- | --- | --- |
| `videos.list` (description) | 1 | 10,000 |
| `captions.list` | 50 | 200 |
| `captions.download` | 200 | 50 |

Descriptions are **50× cheaper to check than caption availability** and 200×
cheaper than a download would be. Even if the auth problem vanished tomorrow, a
caption-first pipeline would hit the quota ceiling at ~50 videos/day without a
paid quota increase. The full 5-video spike cost 1,455 units.

## Decision

1. **Descriptions are the primary content source.** The extraction pipeline
   takes `videos.list` → description → normalize → LLM extraction. This is the
   default path for every video, and it costs 1 quota unit.

2. **Captions are an optional enrichment, not a dependency.** No pipeline stage
   may block on captions. When they are unavailable — which is the normal case —
   extraction proceeds from the description alone.

3. **Do not build the caption path in Phase 2.** It is unreachable for videos we
   do not own. Revisit only when a real creator has opted in and granted OAuth,
   at which point run the 401-vs-403 experiment above before building anything.

4. **Detect and degrade rather than fail.** When a description yields no usable
   ingredients (the Hebbars Kitchen case, 1/5 here), return an explicit
   "insufficient source material" state. Never let the LLM invent a recipe from
   a title and a link. This becomes a tracked metric, not a silent failure.

5. **Creator-permissioned launch is reaffirmed, with a changed rationale.** The
   plan framed creator OAuth as the fallback that makes the project *viable*. It
   is not — descriptions already make it viable. Creator permission is now about
   **quality** (captions add technique and timing that descriptions omit) and
   about **legal posture**. That is a weaker dependency, which is good: it means
   launch is not blocked on creator replies.

6. **No yt-dlp, no transcript scrapers. Unchanged.** The official API's refusal
   is a finding we design around, not an obstacle to route around. Self-hosted
   Whisper on the audio track — the plan's option 3 — is **not** adopted: it
   requires obtaining the audio, which reintroduces exactly the ToS problem, and
   descriptions removed the need.

## Consequences

**Good:**

- The highest-risk unknown is resolved, and the project is viable at 1 quota unit
  per video rather than 250.
- Descriptions are already plain text — no ASR error, no timestamp stripping, no
  sponsor-segment removal from spoken audio. The Phase 2.3 normalization stage
  gets substantially simpler.
- Quantities in descriptions are creator-authored and written down, which should
  make quantity accuracy (target > 0.85) easier than parsing them from speech.
- Launch does not block on creator replies.

**Bad:**

- Creators who deliberately withhold recipes to drive traffic to their own sites
  are unservable, and they are disproportionately the *large* ones. Creator
  selection for Phase 9 must weight description quality heavily — check the
  description before writing the outreach email.
- Descriptions omit technique and timing that the video carries. Extracted steps
  will be terser than what a transcript would give. This is a real product
  ceiling and it should be measured in Phase 2.2, not assumed away.
- `INGREDIENTS_ONLY` descriptions (1/5 here) produce a recipe with no method.
  Decide in Phase 2 whether that ships as a partial recipe or is withheld.
- The Phase 2.2 eval set must be built on **description-sourced** extraction. If
  it were labelled against transcripts, every metric would measure something the
  product does not do.

**Neutral:**

- `packages/scaling` is unaffected — it operates on structured recipes and does
  not care where they came from.

## Revisit if

- A creator opts in and grants OAuth — run the 401-vs-403 experiment first.
- Google changes captions auth, or a paid quota tier changes the economics.
- Phase 2.2 measures description-sourced ingredient recall below the 0.90 gate,
  in which case captions become worth their cost and the creator-permissioned
  model returns to being load-bearing.

## Reproducing

```bash
uv run scripts/spike_captions.py                    # live, ~1,455 units for 5 videos
uv run scripts/spike_captions.py ID1 ID2            # any other videos
uv run scripts/spike_captions.py --replay-q4        # re-analyse cached text, 0 units
```
