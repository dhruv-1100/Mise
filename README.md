# Mise

Turn any cooking video into a structured, scalable recipe you can actually cook
from.

**Live:** [mise-prod.vercel.app](https://mise-prod.vercel.app) — paste a YouTube
URL, watch the extraction run, get a recipe you can scale, convert to metric,
and cook from with timers.

> **Status.** Phases 0–6 are built and deployed. Phases 7–12 (observability,
> load testing, launch, recommender, A/B) are not started. Two things are
> knowingly outstanding and are called out under [What does not
> work](#what-does-not-work) rather than buried: the accuracy eval set is
> unlabelled, so **there is no accuracy number**, and Lighthouse has never been
> run. See [`BUILD_PLAN.md`](BUILD_PLAN.md) for all 12 phases and
> [`CLAUDE.md`](CLAUDE.md) for the conventions that govern the code.

## What it does

- **Extraction.** A YouTube URL becomes a typed recipe: ingredients with
  quantities and units, ordered steps, yield, equipment. Gemini does the reading;
  the contract in [`packages/schema`](packages/schema) decides what counts as a
  recipe.
- **It never invents a quantity.** "A good handful" stays `qty: null` with the
  creator's wording preserved. A plausible number nobody wrote down is the worst
  thing this system could produce, so the schema makes it unrepresentable.
- **Scaling that understands cooking.** Salt grows sublinearly, eggs round to
  whole units (or suggest a yolk), baking ratios stay exact, and pan-size and
  batching advice appears when the factor warrants it.
  [`packages/scaling`](packages/scaling) is pure, property-tested, and held at
  100% branch coverage.
- **When the description has no recipe, it watches the video.** Roughly one
  description in five carries nothing usable. Gemini reads the video itself as a
  fallback — see [ADR 0006](docs/adr/0006-video-fallback.md).
- **Cook mode.** Step-by-step, screen kept awake, inline timers that survive a
  locked phone because they count from a wall-clock timestamp rather than
  ticking down.
- **Accounts.** Google OAuth2, JWT sessions over database users, RBAC. Save
  recipes, keep notes, count cooks. Verified creators can correct extractions of
  their own videos; anyone can keep their own edited version of any recipe.

## Architecture

```
apps/web          Next.js 15 App Router — BFF. Talks gRPC to the extractor,
                  bridges it to SSE for the browser. Auth.js, Neon over HTTPS.
apps/extractor    Python 3.12 — owns every LLM call. gRPC surface + worker pool
                  in one process; Redis-backed queue with retry, DLQ and cache.
packages/scaling  pure TypeScript scaling engine, zero runtime deps
packages/schema   the recipe contract (zod), mirrored in Pydantic, plus the
                  protobuf service definition
infra             Terraform: Neon, Upstash, Vercel, Grafana, Cloud Run
docs/adr          six architecture decision records
```

The web app never calls an LLM. The extractor never renders anything. The
contract between them is checked from both sides against the same JSON fixtures,
which is what stops the zod and Pydantic definitions drifting.

## Setup

Node ≥ 20.9, Python 3.12, and [uv](https://docs.astral.sh/uv/).

```bash
corepack enable pnpm
pnpm install
cd apps/extractor && uv sync && cd ../..
cp .env.example .env    # YOUTUBE_API_KEY and GEMINI_API_KEY at minimum
```

`DATABASE_URL` and `REDIS_URL` come from `terraform -chdir=infra output`; without
them the app still serves recipes and simply has no accounts and no queue.

## Commands

| Command | What it does |
| --- | --- |
| `pnpm dev` | Next.js dev server on :3000 |
| `pnpm test` | vitest — 216 tests, fails if scaling drops below 100% branches |
| `pnpm --filter @mise/web e2e` | Playwright — 31 specs, mobile and desktop |
| `pnpm lint` / `pnpm typecheck` | across all workspaces |
| `pnpm --filter @mise/web migrate` | apply `apps/extractor/migrations/*.sql` (`--dry` to list) |
| `uv run pytest` | extractor — 410 tests (from `apps/extractor`) |
| `./scripts/codegen.sh` | regenerate gRPC stubs after editing the proto |

## Deployment

Both halves deploy from `main`. The extractor image is built and rolled onto
Cloud Run by [`deploy.yml`](.github/workflows/deploy.yml) once CI passes,
authenticating with Workload Identity Federation — no key exists anywhere. The
web app is built by Vercel's git integration.

Setup, the six repository variables, and how to turn accounts on are in
[`infra/README.md`](infra/README.md).

**One thing that will bite you:** Vercel bakes environment variables into a
build. `terraform apply` writes them to the project, but the running deployment
keeps whatever it was built with until you push again.

## What does not work

Stated plainly, because a README that only lists what works is marketing.

- **There is no accuracy number.** The 50-video eval set
  ([`apps/extractor/tests/fixtures/eval/`](apps/extractor/tests/fixtures/eval))
  is scaffolded but unlabelled, so precision, recall and quantity accuracy are
  all unmeasured. Phase 2's exit gate cannot be evaluated. See
  [`docs/LABELLING.md`](docs/LABELLING.md).
- **Lighthouse has never been run**, so the ≥95 performance and accessibility
  target in Phase 6 is unverified.
- **Extraction is slower than the design assumed.** Measured in production:
  12–90s for the description path, and about 28s more when it falls back to
  watching the video. The 60s target in [`docs/METRICS.md`](docs/METRICS.md) is
  missed by the slow half.
- **No observability.** No Prometheus, no tracing, no dashboards — Phase 7. A
  149.8s description stage was observed once and nothing currently explains it.
- **Entity resolution and the sanity-rule validator** from Phase 2.3 are not
  built.

## Legal posture

Recipes — ingredient lists and functional steps — are not copyrightable in the
US. The creative expression around them is, and so are transcripts and
descriptions. Accordingly: **official YouTube Data API only** (no `yt-dlp`, no
transcript scrapers, enforced by a CI check), the structured extraction is stored
but raw transcripts never are, attribution with an embedded player is required by
the schema rather than by convention, and the launch is creator-permissioned.

The video fallback in [ADR 0006](docs/adr/0006-video-fallback.md) hands a URL to
Gemini rather than pulling media off YouTube, and the tension that creates with
[ADR 0001](docs/adr/0001-content-sourcing.md) is documented there rather than
glossed.

## Decision records

| | |
| --- | --- |
| [0001](docs/adr/0001-content-sourcing.md) | Captions need creator OAuth; descriptions are the primary source |
| [0002](docs/adr/0002-llm-provider.md) | Gemini, behind an `LlmProvider` interface |
| [0003](docs/adr/0003-auth-and-sessions.md) | JWT sessions over database users; token lifecycle |
| [0004](docs/adr/0004-analytics-and-retention.md) | Retention cohorts, defined before there is anyone to measure |
| [0005](docs/adr/0005-cloud-run-topology.md) | One process, one port, no keys; scale-to-zero and what it costs |
| [0006](docs/adr/0006-video-fallback.md) | Watching the video when the description has no recipe |

Every outage and every bug that reached a user is in
[`docs/INCIDENTS.md`](docs/INCIDENTS.md).
