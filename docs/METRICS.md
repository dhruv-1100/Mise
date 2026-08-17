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

## Product

| Metric | Current |
| --- | --- |
| Registered users | — |
| DAU / WAU | — |
| D1 / D7 / D30 retention | — |
| Saves per user | — |
| Cook-mode sessions started / completed | — |
| Extractions per week | — |

## Infrastructure

| Metric | Current |
| --- | --- |
| Cost per month | $0 (nothing provisioned) |
| Queue depth (p95) | — |
| Error rate | — |
| Cache hit rate | — |
| Cost per extraction | — |

## Content sourcing

Populated by `scripts/spike_captions.py`; see
`docs/adr/0001-content-sourcing.md`.

| Metric | Current |
| --- | --- |
| Videos where `captions.list` returns ≥1 track | — |
| Videos where `captions.download` succeeds without owner OAuth | — |
| Descriptions carrying a usable ingredient list | — |
| Creators opted in | 0 |

---

## Log

| Date | Note |
| --- | --- |
| 2026-08-17 | File created. Phase 0 scaffold complete; nothing measured yet. |
