# Mise — Build Plan

**Working title:** Mise (from *mise en place*). Alternatives: Forkcast, Prepd, Cookmark.
**One-line pitch:** Turn any cooking video into a structured, scalable recipe you can actually cook from.

**Target:** shipped, instrumented, and carrying real metrics before Summer 2027 applications open (Aug–Sep 2026 for early cycles).

---

## Part 0 — Why this project, in resume terms

Your resume's remaining weaknesses are not technical depth. They are:

| Gap on resume today | Phase that closes it | Bullet it produces |
|---|---|---|
| No system with real users | 9, 10 | "N registered users, M weekly active" |
| No observability keywords (Prometheus, Grafana, tracing) | 7 | "instrumented with Prometheus/OpenTelemetry; p99 …" |
| No IaC (Terraform) | 1 | "provisioned via Terraform" |
| No queues / async processing (Celery, Redis, SQS) | 4 | "async extraction pipeline processing N videos/hr" |
| No auth vocabulary (OAuth2, JWT, RBAC) | 6 | "OAuth2 + JWT session handling" |
| Testing listed but never demonstrated | 2, 3, 8 | "N% branch coverage; property-based tests on scaling engine" |
| No A/B test / experimentation | 11 | "ranker improved save-rate X% over baseline (p<0.05)" |
| No load testing | 8 | "sustained N RPS at p99 <200ms" |
| No gRPC / service-to-service | 4 | "gRPC between Next.js BFF and Python extraction service" |
| Everything reads solo, no process signal | 1 | CI, code review discipline, ADRs |
| Weakest project (OnboardOps) has zero metrics | 12 | Replace it |

**Read that table before every phase.** The point is not to build the best possible recipe app. It is to build a genuinely good product whose construction generates defensible numbers. If a phase is running long, cut product scope, never instrumentation.

---

## Part 1 — Guardrails to set before writing any code

### Legal posture (do this first, it constrains architecture)

Recipes themselves — lists of ingredients and functional steps — are **not copyrightable** in the US. Creative expression around them (headnotes, narrative, photos) **is**. Transcripts and video descriptions **are** copyrighted, and YouTube's ToS restricts automated downloading.

Design accordingly:

1. Use the **official YouTube Data API v3** (`captions.list`, `captions.download`) rather than `yt-dlp` or transcript scrapers. Note that `captions.download` requires the video owner's OAuth for most videos — this is the single biggest technical constraint in the project, and you must verify it in Phase 2 before building on top of it.
2. **Store the structured extraction, not the transcript.** Transcripts are working memory: fetch, extract, discard. Never persist raw transcript text in your database.
3. **Attribute aggressively.** Creator name, channel link, and an embedded video player on every recipe page. You are a companion to the video, not a replacement.
4. **Creator-permissioned launch.** Start with 5–10 creators who explicitly opt in. This is your best legal posture *and* your best distribution channel — a creator who mentions you reaches more people than you will alone.
5. Ship a **DMCA / takedown page** and a creator opt-out form before public launch.

Write this up as `docs/adr/0001-content-sourcing.md`. An architecture decision record showing you reasoned about legal exposure is itself an interview asset.

### Metrics discipline

Create `docs/METRICS.md` in the first commit and update it weekly. Track:

- Extraction: precision/recall on ingredients, quantities, steps; % requiring manual correction
- Performance: p50/p95/p99 for extraction job, recipe page TTFB, search latency
- Product: signups, DAU/WAU, D1/D7/D30 retention, saves per user, cook-mode sessions
- Infra: cost per month, queue depth, error rate

**The number you cannot reconstruct later is retention.** Instrument it in Phase 6, not Phase 11.

### Repo conventions

```
mise/
├── apps/
│   ├── web/                 # Next.js 15, App Router, TS
│   └── extractor/           # Python 3.12, FastAPI
├── packages/
│   ├── scaling/             # TS — pure scaling engine, heavily tested
│   └── schema/              # shared types, protobuf defs
├── infra/                   # Terraform
├── docs/
│   ├── adr/
│   ├── METRICS.md
│   └── INCIDENTS.md
└── CLAUDE.md
```

Keep `docs/INCIDENTS.md` from day one. Every outage, every bug that reached a user: what broke, how you found it, how you fixed it, what you changed to prevent it. **This file will matter more in interviews than any feature you ship.**

---

## Phase 0 — CLAUDE.md and Claude Code setup

**Duration:** half a day

Before any feature work, write the file that governs how Claude Code behaves in this repo.

**`CLAUDE.md` should contain:**

```markdown
# Mise

## What this is
A web app that converts cooking videos into structured, scalable recipes.

## Architecture
- apps/web — Next.js 15 App Router, TypeScript, Tailwind. BFF pattern.
- apps/extractor — Python FastAPI. Owns all LLM calls and parsing.
- packages/scaling — pure TypeScript, zero deps, 100% branch coverage required.
- Postgres (Neon) with pgvector. Redis for cache + job queue.

## Non-negotiables
- Never persist raw transcript text. Extract, then discard.
- packages/scaling must stay dependency-free and deterministic.
- Every API route returns a typed error envelope, never a raw exception.
- No `any` in TypeScript. No bare `except:` in Python.
- Every new endpoint gets a Prometheus counter and histogram.

## Commands
- `pnpm dev`, `pnpm test`, `pnpm lint`
- `uv run pytest`, `uv run ruff check`
- `terraform -chdir=infra plan`

## Testing
- packages/scaling: property-based tests via fast-check. Required.
- extractor: pytest with golden-file fixtures in tests/fixtures/
- web: Playwright for cook-mode flows only. Don't unit test React.

## Style
- Conventional commits.
- One ADR per irreversible decision, in docs/adr/.
```

**Working pattern with Claude Code that actually helps:**

- Start each session by having it read `CLAUDE.md` and the relevant ADRs.
- Ask for a **plan before implementation** on anything touching more than two files.
- For the scaling engine specifically, write the tests first and have Claude Code make them pass. It is the one component where correctness matters more than speed.
- Use `/clear` between phases. Long contexts degrade on refactoring work.
- Have it write the ADR *after* a decision is made, from the actual diff. Retroactive ADRs are more honest than aspirational ones.

**Exit criteria:** repo scaffolded, `CLAUDE.md` committed, `pnpm test` and `uv run pytest` both run and pass on empty suites.

---

## Phase 1 — Infrastructure and CI

**Duration:** 2–3 days
**Closes:** Terraform/IaC, GitHub Actions, observability foundation

Do this *before* features. Retrofitting infrastructure is where side projects die.

### 1.1 Provisioning (Terraform)

```
infra/
├── main.tf
├── neon.tf          # Postgres + pgvector
├── upstash.tf       # Redis
├── vercel.tf        # web app
├── railway.tf       # extractor service
└── grafana.tf       # Grafana Cloud (free tier)
```

Use the free tiers deliberately: Neon (Postgres), Upstash (Redis), Vercel (web), Railway or Fly.io (Python service), Grafana Cloud (metrics). Total cost should sit near $0–15/month, which is itself a resume-worthy number: *"operated at $12/month for N users."*

**Claude Code prompt:**
> Write Terraform for a Neon Postgres project with pgvector enabled, an Upstash Redis instance, and a Grafana Cloud stack. Use variables for all project names. Include a `terraform.tfvars.example`. Do not commit secrets — read them from environment.

### 1.2 CI (GitHub Actions)

Three workflows:

- `ci.yml` — on PR: lint, typecheck, test both apps, build. Required to merge.
- `deploy.yml` — on main: deploy web to Vercel, extractor to Railway.
- `eval.yml` — nightly: run the extraction eval set, post accuracy to a job summary, fail if it regresses more than 2 points.

That third one is unusual and worth having. **A CI job that gates on model quality is exactly the kind of thing an ML-infra interviewer notices**, and it ties directly to your test-prioritization research background.

### 1.3 Branch discipline

Work on branches, open PRs to yourself, let CI gate them. It feels silly solo, but it produces a commit history that looks like an engineer's rather than a student's — and it's the only "process" signal available to you on a solo project.

**Exit criteria:** `terraform apply` provisions everything from scratch; a green PR check on an empty repo; deploy pipeline pushes a hello-world to production URLs.

---

## Phase 2 — Extraction spike and eval harness

**Duration:** 4–5 days
**Closes:** the highest-risk unknown in the project

**Do not build the product until this phase answers one question: can you reliably get captions?**

### 2.1 The captions reality check (day 1)

Test, in this order:

1. YouTube Data API `captions.list` on a target creator's video — do captions exist and are they listed?
2. `captions.download` — confirm whether it returns 403 without owner OAuth. **Assume it will.**
3. If blocked: pivot to a creator-permissioned model where creators grant OAuth access to their own captions, or fall back to **audio transcription you run yourself** (Whisper on the audio track) — which has its own ToS considerations, so document the decision in an ADR.
4. Also test: how much of the recipe is in the **description alone**? For many creators it's 60–80%, which may make transcripts a nice-to-have rather than a dependency.

**This is a genuine fork in the project.** Spend the day. If captions are hard, creator-permissioned becomes mandatory rather than optional, which changes your launch plan.

### 2.2 The eval set (day 2)

Hand-label **50 videos** across 5 creators. For each, write the ground-truth JSON by hand:

```json
{
  "video_id": "...",
  "ingredients": [
    {"name": "olive oil", "qty": 2, "unit": "tbsp", "prep": null, "optional": false},
    {"name": "garlic", "qty": 4, "unit": "clove", "prep": "minced", "optional": false}
  ],
  "steps": [{"index": 1, "text": "...", "duration_s": 300, "temp_c": 180}],
  "yield": {"qty": 4, "unit": "serving"},
  "equipment": ["12-inch skillet"]
}
```

This is tedious and it is the most valuable four hours in the entire project. **Without it you have no accuracy number, and without an accuracy number this project produces no defensible resume bullet.**

Define your metrics precisely in `docs/METRICS.md`:
- **Ingredient recall** — fraction of true ingredients found
- **Ingredient precision** — fraction of extracted ingredients that are real
- **Quantity accuracy** — of correctly-identified ingredients, fraction with correct qty+unit
- **Step ordering** — Kendall tau against ground truth
- **Structural validity** — fraction producing schema-valid output

### 2.3 The extraction pipeline (days 3–5)

```
video_id
  → fetch description + captions (YouTube Data API)
  → normalize (strip timestamps, sponsor reads, "link in bio")
  → LLM extraction (structured output, JSON schema enforced)
  → unit normalization (→ canonical grams/ml where possible)
  → ingredient entity resolution (fuzzy match to a canonical ingredient table)
  → validation (schema + sanity rules)
  → persist structured recipe
```

**Hard parts to handle explicitly:**

- **Vague quantities** — "a glug," "a good handful," "season to taste." Map to a `qty: null, qty_text: "to taste"` rather than guessing a number. Never invent precision that wasn't there.
- **Description/transcript conflict** — description says 2 cups, creator says 3. Prefer description for quantities, transcript for technique. Flag conflicts in a `confidence` field.
- **Implicit references** — "add the rest of the butter" requires tracking state across steps.
- **Sponsor segments** — strip them or they pollute step extraction.

**Claude Code prompt:**
> Build `apps/extractor/pipeline.py` implementing the stages above. Use Pydantic models from `packages/schema`. Each stage is a pure function taking and returning a typed object so stages can be tested independently. Write golden-file tests in `tests/fixtures/` for the 50 eval videos. Add a `scripts/eval.py` that runs the full set and prints a table of the five metrics.

**Exit criteria:** `python scripts/eval.py` prints an accuracy table. **Ingredient recall above 0.90 and quantity accuracy above 0.85** before proceeding. If you're below that, iterate on prompting and normalization — do not move on. Everything downstream is worthless if extraction is unreliable.

---

## Phase 3 — The scaling engine

**Duration:** 3–4 days
**Closes:** testing depth, algorithmic substance

This is the feature users will remember and the component with the most interesting logic. Build it as a **pure, dependency-free TypeScript package** so it's trivially testable and portable.

### Why scaling is not multiplication

| Case | Naive | Correct |
|---|---|---|
| Salt, spices, leavening | ×3 | Sublinear — roughly ×2.2 for ×3 volume; season to taste above 2× |
| Eggs | 1.5 eggs | Round to whole; suggest "1 egg + 1 yolk" for halves |
| Pan size | unchanged | Surface area scales with volume; recommend larger pan or batching |
| Cook time | ×3 | Roughly unchanged for thin items; longer for depth-limited items |
| Liquid in braises | ×3 | Sublinear — evaporation doesn't scale with volume |
| Yeast | ×3 | Sublinear; fermentation is time- and temperature-driven |
| Baking | ×3 | Ratios must hold exactly — flag as precision-critical |

**Design:**

```ts
scale(recipe: Recipe, targetServings: number): ScaledRecipe
// ScaledRecipe carries per-ingredient `warnings: ScalingWarning[]`
// and recipe-level `advisories` (pan size, batching, time adjustment)
```

Classify each ingredient into a `ScalingClass` — `LINEAR | SUBLINEAR | DISCRETE | PRECISION_CRITICAL` — derived from an ingredient taxonomy table. Baking recipes force `PRECISION_CRITICAL` on flour/liquid/leavening ratios.

Also handle **unit display intelligence**: 0.33 cups should render as "1/3 cup," not "0.33 cup." 1.5 tbsp becomes "1 tbsp + 1½ tsp" when that's clearer. Fractions render as fractions.

### Testing (this is the point)

- **Property-based tests** with `fast-check`:
  - Scaling to the original serving count is the identity
  - `scale(scale(r, 2), 0.5)` returns to the original within tolerance
  - Scaling is monotonic — more servings never yields less of a linear ingredient
  - Output is always schema-valid for any positive serving count
- **100% branch coverage** on this package, enforced in CI.
- Golden tests for the discrete cases (eggs, whole vegetables).

**Resume value:** *"Property-based test suite over a deterministic scaling engine handling sublinear, discrete, and precision-critical ingredient classes; 100% branch coverage enforced in CI."* That is a specific, credible testing bullet — and it finally demonstrates the testing expertise your 2023 internship claims.

**Exit criteria:** package published internally, 100% branch coverage, property tests green.

---

## Phase 4 — Async job pipeline

**Duration:** 3 days
**Closes:** queues, async processing, gRPC, backpressure

Extraction takes 10–40 seconds. It cannot be a synchronous request.

**Architecture:**

```
Next.js BFF ──gRPC──▶ FastAPI extractor
     │                      │
     └──▶ Redis queue ◀─────┘
              │
         worker pool (2 workers)
              │
         Postgres + status pubsub → SSE to client
```

**Decisions worth making deliberately:**

- **gRPC between web and extractor** rather than REST. You already list Protobuf-adjacent skills nowhere; this adds a real one. Define the service in `packages/schema/extractor.proto`, generate both TS and Python stubs in CI.
- **Redis-backed queue** (BullMQ or Celery + Redis). Real job semantics: retries with exponential backoff, dead-letter queue, idempotency keys so a re-submitted video doesn't re-extract.
- **Server-Sent Events** for job status to the client. You already have SSE on your resume from Aaron Technologies; this reinforces it.
- **Backpressure** — cap queue depth, return 429 with `Retry-After` when saturated. Deliberately test what happens when you exceed capacity, and write it up in `INCIDENTS.md`.
- **Caching** — a video extracted once is never extracted again. Cache hit rate is a metric worth reporting.

**Claude Code prompt:**
> Define `extractor.proto` with an `Extract` RPC taking a video_id and returning a job_id, plus a `GetStatus` streaming RPC. Generate TS and Python stubs. Wire the Next.js route handler to enqueue via BullMQ, and stream status to the client over SSE. Include idempotency by video_id and exponential-backoff retry with a DLQ.

**Exit criteria:** submit a video URL, watch live status, get a structured recipe. Re-submitting the same video returns instantly from cache.

---

## Phase 5 — Design (Claude Design)

**Duration:** 2–3 days
**Closes:** visual quality, which affects retention more than you expect

Do design *after* the pipeline works, so you're designing around real data rather than imagined data. But do it *before* building the full UI, so you build once.

### What to produce in Claude Design

Work through these as separate canvases:

**5.1 — Design tokens**
Colour scale, type scale, spacing scale, radii, shadows. Pick a distinctive direction; avoid the default Tailwind blue-and-gray look that signals "template." Food benefits from warmth — consider a warm neutral base with a single saturated accent.

Constraint to state up front: **the cooking view must be legible at arm's length on a phone propped on a counter, by someone with wet hands.** That means a minimum 18px body in cook mode, 44px minimum tap targets, and very high contrast. Design for that first and scale down for browsing, not the reverse.

**5.2 — Core screens**
1. **Landing** — paste a URL, one input, immediate value
2. **Extraction in progress** — live status, not a spinner. Show stage names.
3. **Recipe view** — ingredients, steps, embedded video, creator attribution, serving stepper
4. **Cook mode** — full screen, one step at a time, large text, timers, wake lock on
5. **Creator page** — all recipes from one creator, searchable
6. **Feed / discovery** — the recommender surface (Phase 10)
7. **Saved recipes**
8. **Empty and error states** — extraction failed, no captions available, rate limited

**5.3 — The serving stepper interaction**
This is your signature feature; design it carefully. Quantities should animate as they change. Warnings ("season to taste above 2×", "use a 12-inch skillet") appear inline, not in a modal. Fractions render as fractions.

**5.4 — Mobile-first specification**
Design at 390px first. Desktop is the adaptation, not the default. Your users are in kitchens.

**5.5 — Accessibility pass**
You did WCAG remediation at Aaron Technologies — apply it here deliberately. Contrast ratios documented against 2.1 AA, focus order specified, cook mode fully keyboard and screen-reader navigable, `prefers-reduced-motion` respected. Write it up; it's a differentiator almost no side project has.

**Handoff to Claude Code:** export tokens as CSS custom properties and a Tailwind config, and keep the screen designs open in a second window while implementing. Ask Claude Code to build components against the token file, never with hardcoded values.

**Exit criteria:** token file committed, 8 screens designed at mobile and desktop widths, accessibility notes written.

---

## Phase 6 — Web app and accounts

**Duration:** 5–7 days
**Closes:** OAuth2/JWT, RBAC, SSR/SEO, retention instrumentation

### 6.1 Public surface (build first, no auth required)

Anyone can paste a URL and get a recipe. **No signup wall.** Friction before value is how consumer products die.

- Server-render recipe pages with real URLs: `/r/[creator]/[slug]`
- **Recipe JSON-LD structured data** on every page — you did this at Aaron Technologies, and recipe schema is one of the few types Google renders as a rich result. This is your main organic acquisition channel and it costs nothing.
- Open Graph images generated per recipe for link previews.
- Cook mode with Wake Lock API, step-by-step, inline timers.

### 6.2 Accounts (add second)

- **NextAuth with Google OAuth2.** Sessions as JWT. Document the token lifecycle in an ADR.
- Simple **RBAC**: `user`, `creator`, `admin`. Creators can claim their channel and edit extractions of their own videos — this is both a real feature and your creator-relationship strategy.
- Saves, cooked-count, personal notes on recipes.

### 6.3 Analytics — do not skip this

Install PostHog (generous free tier) on day one of this phase. Track:

- `signup`, `recipe_extracted`, `recipe_viewed`, `recipe_saved`, `cook_mode_started`, `cook_mode_completed`, `servings_changed`
- Define **D1/D7/D30 retention cohorts** now. Retention cannot be reconstructed retroactively.

**Exit criteria:** deployed, a stranger can use it without signing up, accounts work, analytics firing, Lighthouse ≥95 on performance and accessibility.

---

## Phase 7 — Observability

**Duration:** 2–3 days
**Closes:** Prometheus, Grafana, OpenTelemetry, SLOs

- **Prometheus metrics** from both services: request counters, latency histograms, queue depth gauge, extraction success rate, cache hit rate, cost-per-extraction.
- **OpenTelemetry tracing** across the gRPC boundary so you can see a full request from browser through BFF through queue through extractor.
- **Grafana dashboards**: one for system health, one for the extraction pipeline, one for product metrics.
- **Alerts**: p99 latency, error rate, queue depth, DLQ non-empty. Route to your phone.
- **Define SLOs explicitly** in `docs/SLO.md`: e.g. 99% of recipe pages under 500ms TTFB; 95% of extractions complete under 60s. Then measure whether you hit them.

Stating an SLO and reporting your actual attainment is a senior-engineer move that almost no student does. It's worth a resume line by itself.

**Exit criteria:** three dashboards live, one alert deliberately triggered and resolved, first `INCIDENTS.md` entry written.

---

## Phase 8 — Load testing and hardening

**Duration:** 2–3 days
**Closes:** load testing, capacity numbers, security

- **k6 load tests** against recipe pages, search, and extraction submission. Find the breaking point. Document RPS at p99 <200ms, and where it degrades.
- **Rate limiting** — per-IP and per-user, Redis token bucket. Extraction is expensive; protect it.
- **Security pass**: input validation on the URL parser (SSRF is a real risk when you fetch user-supplied URLs), CSP headers, no secrets in client bundles, dependency audit in CI, parameterized queries everywhere.
- **Failure injection** — kill a worker mid-job, exhaust the connection pool, fill the queue. Confirm graceful degradation. Every finding goes in `INCIDENTS.md`.

**Resume value:** *"Load tested to N RPS at p99 185ms; identified and fixed connection-pool exhaustion under 12× normal load."* That second clause is worth more than the first.

**Exit criteria:** capacity numbers documented, three failure modes injected and handled.

---

## Phase 9 — Creator outreach and launch

**Duration:** ongoing from here
**Closes:** the users gap — the most important one

**This is the phase most engineers skip and then have no metrics.** Budget real time for it.

### 9.1 Creator-permissioned seed (weeks 1–2)

Pick 10 mid-size creators (50k–500k subscribers — large enough to have an audience, small enough to answer email). Email each with a **working link to their own recipes already extracted**. Not a pitch deck; a demo of their content.

> "I built a tool that turns your videos into scalable recipe cards. Here are 15 of yours: [link]. Nothing is downloaded or hosted — every card embeds and links back to your video. If you'd rather I remove them, reply and I will, immediately. If you like it, I'd love to add a 'claim your channel' badge so you can correct anything I got wrong."

Two or three will reply. One mention in a community post or video description is worth more traffic than everything else you'll do.

### 9.2 Distribution

- **SEO** is your compounding channel — recipe JSON-LD, one page per recipe, server-rendered. It takes 6–10 weeks to show results, which is exactly why Phase 6 comes early.
- **Reddit**: r/Cooking, r/MealPrepSunday, r/internetparents-style communities. Post the tool solving a specific problem, not as a launch announcement.
- **Your campus**: 26,000 students who cook badly and are exactly your demographic.
- **Product Hunt** once you have 100+ users and it's stable, not before.

### 9.3 Retention loop

Users come for one recipe. They return because their saved recipes live here. Get them to save something on the first visit — that's the single highest-leverage product decision in the project.

**Exit criteria (targets, not guarantees):** 500+ registered users, 150+ WAU, D7 retention above 20%. Even a quarter of these numbers beats every project currently on your resume.

---

## Phase 10 — Recommender

**Duration:** 5–7 days
**Closes:** FAISS/pgvector, two-stage ranking, ML systems depth

**Do not build this before Phase 9.** A recommender with no interaction data is a popularity sort with a neural network taped to it. Wait until you have saves and cooks to learn from.

### Architecture (two-stage, as production systems actually do it)

**Stage 1 — Candidate generation (target: <30ms, recall@500 > 0.9)**
- Recipe embeddings from ingredients + technique + creator + cuisine
- pgvector ANN index (or FAISS if you outgrow it)
- User vector = weighted mean of saved/cooked recipe vectors, recency-decayed
- Blend with popularity and freshness candidates so it isn't a filter bubble

**Stage 2 — Ranking (target: <50ms for 500 candidates)**
- Gradient-boosted ranker (LightGBM) over features: embedding similarity, creator affinity, ingredient overlap with save history, time-to-cook vs. user's historical preference, difficulty, seasonality, popularity prior, recency
- Train on implicit feedback: save = strong positive, cook-mode-completed = stronger, view-without-save = weak negative
- Handle position bias — don't naively train on click position

**Cold start** — content-based only until a user has 3 interactions, then blend. Onboarding asks for 3 cuisines and a skill level; measure whether that beats pure popularity.

**Serving** — precompute candidates hourly, rank at request time. Report p99 for each stage separately; that decomposition is what an ML-systems interviewer wants to see.

**Exit criteria:** feed live, per-stage latency reported, recall@k measured against a held-out set.

---

## Phase 11 — A/B experiment

**Duration:** 2 weeks running, 3 days building
**Closes:** experimentation — the rarest thing on a student resume

Build a small framework: deterministic hash-based bucketing on user id, config-driven variants, exposure logging, results notebook.

**Experiment 1:** learned ranker vs. chronological/popularity baseline.
- **Primary metric:** save rate per session
- **Secondary:** cook-mode starts, D7 return rate
- **Guardrail:** feed latency p99, error rate
- Compute required sample size *before* you start. With a few hundred users you'll need weeks and can only detect large effects — know that going in and pick a metric sensitive enough to move.
- Report with confidence intervals, not just a point estimate.

**Be honest about the outcome.** If the ranker loses, that's still a bullet: *"ran a controlled experiment showing the learned ranker did not beat a popularity baseline at N users; documented that the limiting factor was interaction sparsity, not model quality."* Interviewers respect that far more than a suspiciously large win. A negative result reported well is a strong signal.

**Exit criteria:** experiment run to a pre-registered sample size, result written up in `docs/experiments/`.

---

## Phase 12 — Resume integration

Replace **OnboardOps** — your weakest entry, currently carrying zero metrics.

**Draft (fill the brackets with real numbers, never estimates):**

> **Mise: Video-to-Recipe Extraction & Recommendation Platform** — *Next.js, FastAPI, gRPC, Postgres/pgvector, Redis, Terraform*
> - Built and operate a production platform converting cooking videos into structured, scalable recipes; serving **[N]** users with **[M]** weekly actives at **[$X]**/month infrastructure cost.
> - Engineered an async extraction pipeline (gRPC, Redis queues, idempotent retry with DLQ) achieving **[0.9X]** ingredient recall and **[0.8X]** quantity accuracy against a hand-labeled 50-video eval set, gated by a nightly CI regression job.
> - Deployed a two-stage recommender (pgvector ANN retrieval → LightGBM ranker) at **p99 [XX]ms**; A/B tested against a popularity baseline, **[result]** on save-rate at **[N]** users.

Then update Skills with the terms this project actually earned: **Terraform, Prometheus, Grafana, OpenTelemetry, gRPC, Protobuf, Redis Queues, OAuth2, JWT, k6, LightGBM, pgvector**.

Only list what you genuinely built. This plan is designed so that by the end, every one of those is true.

---

## Realistic schedule

| Phase | Effort | Calendar |
|---|---|---|
| 0–1 Setup + infra | 4 days | Week 1 |
| 2 Extraction + eval | 5 days | Week 2 |
| 3 Scaling engine | 4 days | Week 3 |
| 4 Async pipeline | 3 days | Week 3–4 |
| 5 Design | 3 days | Week 4 |
| 6 Web app + accounts | 7 days | Week 5–6 |
| 7 Observability | 3 days | Week 6 |
| 8 Load + hardening | 3 days | Week 7 |
| 9 Launch + outreach | ongoing | Week 7 onward |
| 10 Recommender | 7 days | Week 10–11 |
| 11 A/B experiment | 3 days + 2 wks | Week 12–14 |
| 12 Resume | 1 day | Week 14 |

**Roughly 14 weeks at 12–15 hours/week alongside coursework.** Starting now puts phases 0–9 done before the fall semester gets heavy, with users accumulating while you're busy — which is exactly the right ordering, since retention data needs calendar time regardless of your effort.

**If you fall behind, cut in this order:** the recommender (Phase 10), then the A/B test (11), then design polish (5). **Never cut** the eval harness (2), observability (7), or launch (9) — those are where the defensible numbers come from.

---

## The failure mode to avoid

The most likely bad outcome is not that this is too hard. It's that you build phases 0–8 beautifully, never do phase 9, and end up with an elegant unused system — which is exactly what your resume already has five of.

**Users are the whole point.** If you have to choose between a better ranker and ten more users, take the users every time.
