# Metrics

Updated weekly. Numbers here must be measured, never estimated — an empty cell
is worth more than a guess.

**The number that cannot be reconstructed later is retention.** It gets
instrumented in Phase 6, not Phase 11.

---

## Extraction quality

Measured against the hand-labelled 50-video eval set (Phase 2.2) by
`scripts/eval.py`. Definitions are fixed here so the number means the same thing
every week.

| Metric | Definition | Gate | Current |
| --- | --- | --- | --- |
| Ingredient recall | fraction of true ingredients found | > 0.90 | — |
| Ingredient precision | fraction of extracted ingredients that are real | — | — |
| Quantity accuracy | of correctly-identified ingredients, fraction with correct qty **and** unit | > 0.85 | — |
| Step ordering | Kendall tau against ground truth | — | — |
| Structural validity | fraction producing schema-valid output | — | — |
| Manual correction rate | fraction of extractions a human had to fix | — | — |

The two gates are exit criteria for Phase 2. Everything downstream is worthless
if extraction is unreliable.

## Performance

| Metric | Target (see `docs/SLO.md`, Phase 7) | p50 | p95 | p99 |
| --- | --- | --- | --- | --- |
| Extraction job, end to end | 95% under 60s | — | — | — |
| Recipe page TTFB | 99% under 500ms | — | — | — |
| Search latency | — | — | — | — |
| Candidate generation (Phase 10) | < 30ms | — | — | — |
| Ranking, 500 candidates (Phase 10) | < 50ms | — | — | — |

**Production measurements, 2026-08-28.** Nine real extractions against the
deployed Cloud Run service. Still too few for a percentile, so the cells above
stay empty, but enough to say the 60s target is not currently met.

| Path | Observed |
| --- | --- |
| Description only | 12.7s, 14.7s, 23.1s, 53.9s, 91.5s |
| Falls back to watching the video (ADR 0006) | 149.8s to reach `watching`, then over 300s total |
| `GetRecipe` on a warm instance | 0.6s |

Three things this changes:

1. **The "10-40 seconds" in the pipeline's own comments is wrong.** Even the
   description-only path runs 12-90s.
2. **The 60s target above is missed by the slow half.** Phase 7 should not
   write an SLO around a number nobody had measured.
3. **The fallback exceeded the 300s stream timeout**, which cut the connection
   while the worker was still going. The job completed and cached; the person
   watching had been told it failed. Timeouts raised to 600s (stream) and 900s
   (Cloud Run) — see `docs/adr/0005-cloud-run-topology.md`.

The decomposition that matters and still does not exist: cold start vs. YouTube
fetch vs. Gemini call. One description stage took 149.8s on its own, which no
current instrumentation explains.

## Product

Instrumented in Phase 6.3. Cohort definitions are fixed in
`docs/adr/0004-analytics-and-retention.md` — read them before quoting any
retention number, because the definition is half of what the number means.

Day 0 is the UTC date of `signup`. **Active** means any product event, never a
bare pageview. D1/D7/D30 are *exactly* that day, not "on or after".

| Metric | Source event(s) | Current |
| --- | --- | --- |
| Registered users | `signup` | — |
| Activated users (got at least one recipe) | `recipe_extracted` | — |
| DAU / WAU | any product event | — |
| D1 / D7 / D30 **returning** | any product event | — / — / — |
| D1 / D7 / D30 **cooking** | `cook_mode_started` | — / — / — |
| Saves per user | `recipe_saved` | — |
| Cook-mode sessions started / completed | `cook_mode_started`, `cook_mode_completed` | — / — |
| Median scale factor | `servings_changed.factor` | — |
| Extractions per week | `recipe_extracted` | — |
| Cache-hit share of extractions | `recipe_extracted.cached` | — |
| Median wait before a recipe appears | `recipe_extracted.waitedMs` | — |

Both retention rows are reported together, always. The returning number is the
comparable one; the cooking number is the true one.

## Infrastructure

| Metric | Current |
| --- | --- |
| Cost per month | $0 — all five providers on free tiers (Neon, Upstash, Vercel, Grafana, Cloud Run) |
| Cost per 1,000 extractions | ~$3.40 (Gemini 3.5 Flash, n=5) |
| Queue depth (p95) | — |
| Error rate | — |
| Cache hit rate | — |
| Cost per extraction | — |

## Content sourcing

Populated by `scripts/spike_captions.py`; see
`docs/adr/0001-content-sourcing.md`.

| Metric | Current | n |
| --- | --- | --- |
| `captions.list` succeeds with an API key | 5/5 | 5 |
| Videos listing ≥1 caption track | 4/5 | 5 |
| Caption tracks downloadable without owner OAuth | **0/6** (all `401 required`) | 6 tracks |
| Descriptions carrying a complete recipe | 3/5 | 5 |
| Descriptions carrying a usable ingredient list | 4/5 | 5 |
| `contentDetails.caption` agreeing with `captions.list` | 4/5 | 5 |
| Creators opted in | 0 | — |

n=5 across 5 creators, skewed toward Indian home-cooking channels. Direction is
trustworthy; the percentages are not. Re-measure on the Phase 2.2 50-video set.

## Quota

| Call | Units | Videos/day at the 10,000-unit default |
| --- | --- | --- |
| `videos.list` | 1 | 10,000 |
| `captions.list` | 50 | 200 |
| `captions.download` | 200 | 50 |

---

## Log

| Date | Note |
| --- | --- |
| 2026-08-17 | File created. Phase 0 scaffold complete; nothing measured yet. |
| 2026-08-17 | Phase 2.1 spike run. Captions unreachable without OAuth (401, not the predicted 403); descriptions carry more than expected. See `docs/adr/0001-content-sourcing.md`. |
| 2026-08-18 | Extraction pipeline running end to end on Gemini over the 5 cached descriptions. 4/5 produced schema-valid recipes; the 5th correctly refused. Normalization removes 20-88% of lines before billing. No accuracy number yet — that needs the Phase 2.2 labelled set. See `docs/adr/0002-llm-provider.md`. |
| 2026-08-24 | Phase 6.2/6.3. Accounts, RBAC and verified creator claims shipped; seven product events wired and cohort definitions fixed in `docs/adr/0004-analytics-and-retention.md`. **Every Product cell is still empty on purpose: nothing is deployed and there are no users.** The clock on D30 starts at the first real signup, not today. |
