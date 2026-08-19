# 0002 — LLM provider: Gemini, behind an interface

- **Status:** Accepted
- **Date:** 2026-08-18
- **Phase:** 2.3 (extraction pipeline)
- **Supersedes:** the assumption in `BUILD_PLAN.md` and the original
  `.env.example` that extraction would run on the Anthropic API.

## Decision

Use **Google Gemini** (AI Studio) for the LLM extraction stage, reached through
an `LlmProvider` protocol rather than called directly.

## Context

`BUILD_PLAN.md` §2.3 specifies "LLM extraction (structured output, JSON schema
enforced)" without naming a vendor. The first `.env.example` guessed Anthropic.
The available credential is a Google AI Studio key, so the decision was made by
what exists rather than by evaluation — worth stating plainly, because it means
this was never a quality comparison between vendors and should not be presented
as one.

What made the choice low-risk is the interface, not the vendor.

## Why an interface rather than a direct call

1. **Tests run offline.** `FakeProvider` returns canned payloads, so the
   mapping, coercion and validation logic — which is where the bugs are — is
   tested with no network, no key, and no bill. 23 of the extraction stage's
   tests run in under a second.
2. **The vendor already changed once.** It moved from Anthropic to Gemini before
   a line of pipeline code existed. Assuming it will not move again would be
   optimistic.
3. **Model availability genuinely moves.** On the day this was written, against
   the same key and within minutes:

   | Model | Result |
   | --- | --- |
   | `gemini-2.5-flash` | HTTP 404 — "no longer available to new users" |
   | `gemini-3.6-flash` | HTTP 503 — "currently experiencing high demand" |
   | `gemini-3.5-flash` | served normally |

   A single pinned model name is an outage with someone else's release schedule
   as its cause. `GeminiProvider` walks an ordered chain and steps past 404, 429
   and 503, while letting a 400 fail loudly — a malformed request is ours and
   retrying elsewhere would only hide it.

## What the model got wrong, and where that is fixed

A probe against a real description produced contract-violating output on the
first attempt, in three distinct ways. All three are corrected in the mapping
layer in `app/extract.py`, not merely discouraged in the prompt, because a
prompt is a request and a mapping is a guarantee.

| Model output | Problem | Handling |
| --- | --- | --- |
| `"8-10 CLOVES"` → `qty: null, unit: "cloves"` | Schema rejects a unit without a quantity, correctly — a unit alone measures nothing | Take the **lower** bound as `qty`, keep `"8-10"` in `qty_text`. Averaging would invent precision |
| `qty: 4` alongside `qty_text: "4"` | `qty_text` exists only for wording a number cannot carry | Dropped when it merely echoes the number |
| `"KASHMIRI RED CHILLI POWDER"` | Source descriptions shout | Lowercased only when fully uppercase, so `MSG` and `San Marzano` survive |

Step indices are assigned during mapping and never taken from the model. The
schema requires them contiguous from 1, and that is our invariant to keep rather
than the model's to remember.

## Result on the real sample

Run end to end over the five descriptions cached by the Phase 2.1 spike, after
normalization:

| Creator | Outcome | Ingredients | Steps |
| --- | --- | --- | --- |
| Your Food Lab | ok | 33 | 9 |
| Chef Ranveer Brar | ok | 22 | 9 |
| CookingShooking | ok | 27 | 0 |
| Hebbars Kitchen | **insufficient_source_material** | — | — |
| James Hoffmann | ok | 2 | 9 |

Every `ok` result validates against the shared `Recipe` contract.

Two of these matter more than the counts. **Hebbars Kitchen returned
`description_is_link_only` rather than a recipe** — the exact case ADR 0001
identified, where the creator withholds the recipe to drive traffic to their own
site, and where the failure mode to avoid is an LLM confabulating a recipe from
a title. **CookingShooking returned 27 ingredients and zero steps**, which is
also correct: that description carries a full ingredient list and no method.

**These are not accuracy numbers.** They are counts against a five-video sample
whose ground truth is one person's reading. Ingredient recall and quantity
accuracy get measured against the hand-labelled 50-video set in Phase 2.2, and
the Phase 2 exit gate (recall > 0.90, quantity accuracy > 0.85) is decided there.

## Cost

~9,900 tokens for five videos, roughly **$3.40 per 1,000 extractions** at Gemini
3.5 Flash pricing. Normalization is doing real work here: it removes 20–88% of
description lines before they are billed as input tokens.

Extraction is cached by `video_id` from Phase 4 onward, so this is a
one-off-per-video cost, not a per-view one.

## Consequences

- `google-genai` becomes a runtime dependency of `apps/extractor`. Chosen over
  hand-rolled HTTP specifically because the model-availability churn above is
  the kind of thing an SDK absorbs.
- `GEMINI_API_KEY` replaces `ANTHROPIC_API_KEY` in `.env.example`.
- Nothing outside `app/llm.py` imports the SDK. Swapping vendors means writing
  one new class.
- The model chain is a constant, not configuration. It should become
  configuration when there is somewhere to configure it from — Phase 1's
  Terraform outputs, not before.
- No prompt-injection defence yet. Descriptions are attacker-controlled text and
  a creator could write "ignore previous instructions" into one. The blast
  radius today is a junk recipe rather than anything worse, because the model
  has no tools and its output is schema-validated, but this needs revisiting
  before the extractor can act on anything it reads.
