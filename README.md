# Mise

Turn any cooking video into a structured, scalable recipe you can actually cook
from.

**Live:** [mise-prod.vercel.app](https://mise-prod.vercel.app) — paste a YouTube
URL, watch the extraction run, get a recipe you can scale, convert to metric,
and cook from with timers.

> **Status.** Phases 0–6 are built, deployed, and exercised end to end against
> production — including sign-in, saving, and per-user recipe edits. Phases 7–12
> (observability, load testing, launch, recommender, A/B) are not started.
> Monitoring is minimal but no longer absent: see [Operations](#operations).
> One thing is knowingly outstanding and called out under [What does not
> work](#what-does-not-work) rather than buried — the accuracy eval set is
> unlabelled, so **there is no accuracy number.**
>
> See [`BUILD_PLAN.md`](BUILD_PLAN.md) for all 12 phases, [`CLAUDE.md`](CLAUDE.md)
> for the conventions that govern the code, and
> [`docs/INCIDENTS.md`](docs/INCIDENTS.md) for what has actually broken.

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
- **Cook mode.** Step-by-step, screen kept awake, and each step carries the
  ingredients it needs at the serving count you chose — so nobody has to leave
  the step, find the quantity, and come back with wet hands. Inline timers
  survive a locked phone, because they count from a wall-clock timestamp rather
  than ticking down.
- **Recipes outlive the cache.** Redis expires an entry after seven days, which
  twice sent the live page to 404 for a recipe already extracted correctly. S3
  is the copy that does not expire, reached by federating the service's own GCP
  identity into an AWS role — no access key exists anywhere. See
  [ADR 0007](docs/adr/0007-recipe-archive.md). *This did not work for the first
  day of its life and nothing noticed; the correction is the second 2026-10-20
  entry in [`docs/INCIDENTS.md`](docs/INCIDENTS.md).*
- **Accounts.** Google OAuth2, JWT sessions over database users, RBAC. Save
  recipes, keep notes, count cooks. Verified creators can correct extractions of
  their own videos; anyone can keep their own edited version of any recipe.
- **Built to a design, not improvised.** Lighthouse scores 100 on performance
  and accessibility across the home, recipe and cook-mode routes. The palette is
  oklch with every foreground/background pair's contrast computed rather than
  eyeballed ([`docs/design/README.md`](docs/design/README.md) carries the
  table). The recipe page is a two-column layout with a sticky ingredient rail
  above 1024px and a single column below.

## Architecture

```
apps/web          Next.js 15 App Router — BFF. Talks gRPC to the extractor,
                  bridges it to SSE for the browser. Auth.js, Neon over HTTPS.
apps/extractor    Python 3.12 — owns every LLM call. gRPC surface + worker pool
                  in one process; Redis-backed queue with retry, DLQ and cache.
packages/scaling  pure TypeScript scaling engine, zero runtime deps
packages/schema   the recipe contract (zod), mirrored in Pydantic, plus the
                  protobuf service definition
infra             Terraform: Neon, Upstash, Vercel, Grafana, Cloud Run, AWS
docs/adr          seven architecture decision records
docs/design       the design system and its measured contrast table
```

The web app never calls an LLM. The extractor never renders anything. The
contract between them is checked from both sides against the same JSON fixtures,
which is what stops the zod and Pydantic definitions drifting.

### Request flow

```
browser ──HTTP──▶ apps/web (Vercel)
                     │
                     ├─ gRPC ──▶ apps/extractor (Cloud Run, scale-to-zero)
                     │              ├─ Redis (Upstash) ─ queue, jobs, cache
                     │              ├─ S3 (AWS)        ─ durable recipe archive
                     │              ├─ YouTube Data API ─ metadata, description
                     │              └─ Gemini           ─ extraction
                     │
                     └─ HTTPS ─▶ Neon Postgres ─ users, saves, notes, edits
```

Status updates reach the browser over SSE from `/api/jobs/[jobId]/events`, which
bridges the gRPC `StreamStatus` stream — browsers cannot speak gRPC without a
proxy.

### Storage tiers

| Tier | Holds | Lifetime |
| --- | --- | --- |
| Redis `mise:cache:*` | extracted recipes | 7 days; 6 hours for "no recipe here" |
| Redis `mise:job:*` | job records | 24 hours |
| Redis `mise:queue` / `mise:dlq` | pending and dead-lettered work | until drained |
| S3 `recipes/*.json` | durable recipe copies | indefinite; 30-day noncurrent version expiry |
| Neon Postgres | users, saves, notes, cook counts, personal edits | indefinite |

**Raw transcript text is never persisted anywhere.** Fetch, extract, discard.

## Running it locally

Node ≥ 20.9, Python 3.12, and [uv](https://docs.astral.sh/uv/).

```bash
corepack enable pnpm
pnpm install
cd apps/extractor && uv sync && cd ../..
cp .env.example .env    # YOUTUBE_API_KEY and GEMINI_API_KEY at minimum
pnpm dev                # :3000
```

Without `DATABASE_URL` and `REDIS_URL` the app still serves recipes and simply
has no accounts and no queue. Both come from `terraform -chdir=infra output`.

| Command | What it does |
| --- | --- |
| `pnpm dev` | Next.js dev server on :3000 |
| `pnpm test` | vitest — 216 tests; fails if scaling drops below 100% branches |
| `pnpm --filter @mise/web e2e` | Playwright — 32 tests across mobile and desktop |
| `pnpm lint` / `pnpm typecheck` | across all workspaces |
| `pnpm --filter @mise/web migrate` | apply `apps/extractor/migrations/*.sql` (`--dry` to list) |
| `uv run pytest` | extractor — 430 tests (from `apps/extractor`) |
| `./scripts/codegen.sh` | regenerate gRPC stubs after editing the proto |

## Configuration

Runtime configuration is environment variables only; there is no config file.
Terraform owns every production value — see [`infra/README.md`](infra/README.md).

### Extractor (Cloud Run)

| Variable | Required | Purpose |
| --- | --- | --- |
| `YOUTUBE_API_KEY` | yes | video metadata and descriptions |
| `GEMINI_API_KEY` | yes | extraction, including the video fallback |
| `REDIS_URL` | yes | queue, job records, recipe cache |
| `PORT` | injected | gRPC bind port; set by Cloud Run |
| `RECIPE_BUCKET` | no | S3 archive bucket |
| `AWS_ROLE_ARN` | no | role federated into from the GCP identity |
| `AWS_TOKEN_AUDIENCE` | no | audience the identity token is minted for |
| `AWS_REGION` | no | must be `us-east-2` |
| `CLOUDWATCH_NAMESPACE` | no | namespace for the dead-letter gauge |

The four `RECIPE_BUCKET` / `AWS_*` values are **all-or-nothing**: none set
disables the archive cleanly, a partial set refuses to boot. That is deliberate —
failing over to "no archive" quietly would hide a deployment mistake until the
next cache expiry, which is months of normal behaviour followed by one
inexplicable 404.

### Web (Vercel)

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | yes | Neon, pooled, over HTTPS |
| `EXTRACTOR_GRPC_ADDRESS` | yes | `host:443` of the Cloud Run service |
| `AUTH_SECRET` | for accounts | Auth.js JWT signing |
| `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` | for accounts | Google OAuth client |
| `AUTH_TRUST_HOST` | yes | `true` behind Vercel's proxy |
| `NEXT_PUBLIC_SITE_URL` | for accounts | canonical URLs, OG tags, OAuth callback |
| `NEXT_PUBLIC_POSTHOG_KEY` | no | analytics; absent falls back to a no-op sink |

## Deployment

Both halves deploy from `main`. The extractor image is built and rolled onto
Cloud Run by [`deploy.yml`](.github/workflows/deploy.yml) once CI passes,
authenticating with Workload Identity Federation — no key exists anywhere. The
web app is built by Vercel's git integration.

Setup, the six repository variables, and how to turn accounts on are in
[`infra/README.md`](infra/README.md).

A deploy finishes by running [`smoke_grpc.py`](apps/extractor/scripts/smoke_grpc.py)
against the new revision. It makes two calls deliberately: `GetRecipe` exercises
the full read path, and `GetStatus` is the one that proves Redis answered —
`GetRecipe` alone returns `found: false` against a Redis that does not exist,
because the read path falls through to S3 by design.

**Two things that will bite you:**

- Vercel bakes environment variables into a build. `terraform apply` writes them
  to the project, but the running deployment keeps whatever it was built with
  until you push again.
- Never run a bare `terraform apply`. Five `TF_VAR_*` default to `""` rather
  than failing, and an apply from a shell that has lost its exports **destroys**
  the Vercel environment variables and breaks sign-in with no error. Use
  `plan -out`, confirm `0 to destroy`, then apply the saved file.
  `source infra/load-state-vars.sh` restores the nine values Terraform already
  holds in state.

## Operations

### Monitoring

| What | How | Where |
| --- | --- | --- |
| Extractor availability | [`canary.yml`](.github/workflows/canary.yml) — one real RPC daily at 06:17 UTC | GitHub Actions |
| Dead-letter queue depth | `DeadLetterDepth` → CloudWatch alarm → SNS email | AWS, `us-east-2` |
| Deploy health | `smoke_grpc.py` as the last deploy step | GitHub Actions |

The canary is doing two jobs. Upstash deletes a free-tier Redis database after
**14 days without traffic**, and this project legitimately goes a fortnight
between visits — so the probe is both the alarm and the traffic that prevents
the thing it alarms on. It is not absolute: GitHub disables scheduled workflows
in a repository with no pushes for 60 days.

**Not monitored, and worth knowing:** the web app's uptime, Neon, extraction
latency, error rates, and — most sharply — AWS federation failures, which are
silent because `treat_missing_data = "notBreaching"` is correct for the DLQ
alarm but means a publisher that cannot authenticate triggers nothing. Phase 7
brings Prometheus and Grafana.

### Degradation

What actually happens when each dependency fails, rather than what one might
hope:

| Dependency | Behaviour | User impact |
| --- | --- | --- |
| **Redis** unreachable | reads fall through to S3; writes fail loudly | existing recipes still serve; new extractions refused |
| **S3** unreachable | logged warning, nothing else | none now; cache-expired recipes need re-extraction later |
| **Gemini** failing | 3 attempts with backoff, then dead-letter | extraction fails; alarm fires |
| **YouTube API** failing | job fails and retries | extraction fails |
| **Neon** unreachable | account routes fail | recipes still serve; no sign-in, saves or edits |
| **Queue at 100 jobs** | enqueue returns 429 | new submissions refused until drained |

Reads degrade, writes fail loudly. A queue that accepts a job it cannot store
has lost the job silently, which is worse than refusing the request.

### Runbook

**Every recipe page errors; extraction does nothing.**
Check Redis first — this is the known failure.

```bash
cd apps/extractor && uv run --frozen python scripts/smoke_grpc.py mise-prod-extractor-ohuulanlva-ue.a.run.app:443
```

`Redis unreachable` means the Upstash database is gone, almost certainly deleted
for inactivity. The provider 404s on a missing resource rather than planning a
replacement, so recovery is `terraform state rm upstash_redis_database.main`
followed by a normal `plan -out` / `apply`. Terraform rolls a new Cloud Run
revision with the new endpoint itself. The cache is lost; recipes in S3 are not.

**Canary is red.** In order: the Upstash console, then
`gcloud run services describe mise-prod-extractor --region us-east1`, then
roll back.

**Recipes are not reaching S3.**

```bash
cd apps/extractor && uv run --frozen python scripts/verify_aws.py VIDEO_ID
```

Archive writes are best-effort and swallow their errors, so the only evidence is
in the logs:

```bash
gcloud run services logs read mise-prod-extractor --region us-east1 --project <project> | grep -i "archive\|assumed"
```

`AccessDenied ... AssumeRoleWithWebIdentity` names no claim and no condition, so
it reads like a missing IAM permission. It usually is not — check that the trust
policy pins `accounts.google.com:oaud` and not `:aud`.

**Sign-in breaks right after a `terraform apply`.** The apply ran from a shell
missing `TF_VAR_auth_secret` and friends, and destroyed the Vercel environment
variables. `source infra/load-state-vars.sh`, re-apply, then redeploy the web
app so the build picks them up.

**Dead-letter alarm fired.** Read the queue before clearing it — the DLQ is the
only record of what failed.

### Rollback

```bash
gcloud run services update-traffic mise-prod-extractor --to-revisions=PREVIOUS=100
```

The web app rolls back from Vercel's deployment list. Terraform state is local
and unlocked, so only one person may apply at a time.

## What does not work

Stated plainly, because a README that only lists what works is marketing.

- **There is no accuracy number.** The 50-video eval set
  ([`apps/extractor/tests/fixtures/eval/`](apps/extractor/tests/fixtures/eval))
  is scaffolded but labelled for 1 video, so precision, recall and quantity
  accuracy are all unmeasured and Phase 2's exit gate cannot be evaluated. See
  [`docs/LABELLING.md`](docs/LABELLING.md). This is the highest-value unfinished
  work in the repository.
- **Extraction is slower than the design assumed.** Measured in production:
  12–90s for the description path, and about 28s more when it falls back to
  watching the video. The 60s target in [`docs/METRICS.md`](docs/METRICS.md) is
  missed by the slow half.
- **Observability is three checks, not a system.** No Prometheus, no tracing, no
  dashboards — Phase 7. A 149.8s description stage was observed once and nothing
  currently explains it.
- **A federation failure is silent.** Covered under
  [Monitoring](#monitoring); the fix is a second CloudWatch alarm on
  `DeadLetterDepth` having no datapoints in 24h, which only became sound once
  the canary guaranteed daily traffic.
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
| [0007](docs/adr/0007-recipe-archive.md) | A durable tier under the cache, reached without a stored key |

Every outage and every bug that reached a user is in
[`docs/INCIDENTS.md`](docs/INCIDENTS.md), including the two from 2026-10-20 that
produced most of the Operations section above.
