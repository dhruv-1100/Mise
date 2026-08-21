# Mise

## What this is

A web app that converts cooking videos into structured, scalable recipes.

**Status:** Phases 0, 2.1, 3, 4, 5 complete; Phase 6.1 (public surface) done —
paste a URL, watch live stages, get a scalable recipe with cook mode. Accounts
(6.2) and analytics (6.3) are not started. Phase 2.3 works from a real YouTube
URL: fetch -> normalize -> extract -> units, exposed as `POST /extract`. Entity
resolution and the sanity-rule validator are still open, and there is no
accuracy number until the Phase 2.2 labelled set exists. Phase 1 nearly done: CI
is green and all five providers are provisioned via Terraform — Neon, Upstash,
Vercel, Grafana and Cloud Run — with a clean plan. The extractor image is still
the placeholder; CI does not build or deploy it yet. The headline finding so far is
`docs/adr/0001-content-sourcing.md` — captions are unreachable without creator
OAuth, so descriptions are the primary source. See `BUILD_PLAN.md` for all 12
phases.

## Architecture

- `apps/web` — Next.js 15 App Router, TypeScript, Tailwind 4. BFF pattern.
  Talks to the extractor over gRPC from `lib/extractor.ts`, which is
  `server-only` — `@grpc/grpc-js` must never reach the browser bundle, which is
  why the generated stubs are transport-agnostic and the transport is bound
  there. `/api/jobs/[jobId]/events` bridges the gRPC status stream to SSE,
  because browsers cannot speak gRPC without a proxy.
  Design tokens live in `app/globals.css`; the design they come from is in
  `docs/design/` (see its README). Build against the tokens, never hardcoded
  values.
- `apps/extractor` — Python 3.12 + FastAPI, managed by uv. Owns all LLM calls
  and parsing. The web app never calls an LLM directly. Pipeline stages are pure
  functions in `app/`: `normalize.py` (strip description noise), `extract.py`
  (LLM extraction and mapping onto the contract), `units.py` (canonical
  grams/ml), `evaluation.py` (scoring against ground truth), `queue.py`
  (Redis-backed jobs: idempotency, retry/DLQ, cache, backpressure),
  `worker.py` (drains the queue), `grpc_server.py` (the BFF-facing surface).
  All LLM access goes through the `LlmProvider` protocol in
  `app/llm.py` — nothing else imports the SDK, and tests use `FakeProvider` so
  they run offline. Entity resolution is not built yet.
- `packages/scaling` — pure TypeScript, zero runtime deps, 100% branch coverage
  enforced (`pnpm test` fails below it, so CI fails below it). `@mise/schema` is
  a devDependency consumed only via `import type`, which is erased at compile
  time — verified by inspecting the emitted JS, not assumed.
- `packages/schema` — the recipe contract, as zod schemas with inferred types.
  Mirrored by hand in `apps/extractor/app/schema.py` (Pydantic); both are
  validated against the shared fixtures in `packages/schema/fixtures/`, which is
  what stops the two definitions drifting. `extractor.proto` is the gRPC
  contract; stubs are generated into `apps/extractor/app/gen/` and
  `packages/schema/src/gen/` by `./scripts/codegen.sh` and committed, and CI
  regenerates and diffs them so they cannot drift from the proto.
- `infra/` — Terraform (Phase 1), all applied and live: Neon, Upstash, Vercel,
  Grafana and Cloud Run. Railway was dropped for having no free tier; see
  `infra/README.md`.
- SQL migrations live in `apps/extractor/migrations/`. pgvector is enabled there
  because no Terraform provider can do it.

Workspace packages export TypeScript source, not build output; `apps/web`
compiles them via `transpilePackages`, so there is no build-ordering problem.

## Non-negotiables

- **Never persist raw transcript text.** Fetch, extract, discard. Transcripts
  are working memory, never database rows.
- Raw fetched third-party text (transcripts, captions, descriptions) may only
  ever be written to `scripts/spike_output/`, which is gitignored.
- **Official YouTube Data API only.** No yt-dlp, no transcript scrapers. If the
  official API cannot do something, that is a finding to document in an ADR, not
  an obstacle to route around.
- `packages/scaling` stays dependency-free and deterministic — no I/O, no clock,
  no randomness.
- Every API route returns a typed error envelope, never a raw exception.
- No `any` in TypeScript (`@typescript-eslint/no-explicit-any` is an error). No
  bare `except:` in Python (ruff `E722`).
- Every new endpoint gets a Prometheus counter and histogram (from Phase 7).
- Attribution is not optional: creator name, channel link, and an embedded
  player on every recipe page.

## Commands

Node 20.20.1 / pnpm 10 (pinned via `packageManager`, installed through corepack).
pnpm 11 requires Node 22.13+, so do not bump it without bumping Node first.

```bash
pnpm install            # once, at the repo root
pnpm dev                # Next.js dev server on :3000
pnpm build              # production build
pnpm test               # vitest; fails if packages/scaling drops below 100% branches
pnpm lint               # eslint across all workspaces
pnpm typecheck          # tsc --noEmit across all workspaces
```

```bash
cd apps/extractor
uv sync                 # once
uv run pytest
uv run ruff check
uv run ruff format
uv run uvicorn app.main:app --reload   # :8000, needs YOUTUBE_API_KEY + GEMINI_API_KEY

# curl -X POST localhost:8000/extract -H 'Content-Type: application/json' \
#   -d '{"video":"https://youtu.be/VIDEO_ID"}'
```

```bash
uv run scripts/spike_captions.py ID1 ID2   # Phase 2.1 spike (self-contained)
uv run scripts/spike_captions.py --replay-q4  # re-analyse cached text, 0 quota

# Eval set (Phase 2.2). Ground truth lives in apps/extractor/tests/fixtures/eval/;
# descriptions are re-fetched at run time and never committed.
cd apps/extractor
uv run python scripts/build_eval_set.py --ids ../../eval_videos.txt
uv run pytest tests/test_eval_labels.py     # validate labels as you write them
uv run python scripts/eval.py --limit 5     # cheap smoke run
uv run python scripts/eval.py --json /tmp/eval.json --fail-under-gate
# Extraction needs GEMINI_API_KEY in .env — see docs/adr/0002-llm-provider.md

./scripts/codegen.sh        # regenerate gRPC stubs after editing extractor.proto

terraform -chdir=infra init
terraform -chdir=infra validate
terraform -chdir=infra plan                # needs TF_VAR_* creds; see infra/README.md
```

## Testing

- `packages/scaling` — property-based tests via fast-check. Required. Write the
  tests first; this is the one component where correctness beats speed. The
  arbitraries call the real `classify()` rather than keeping their own idea of
  what a countable ingredient is — a second copy of that knowledge drifted and
  produced a false failure once already.
- **Labelling the eval set** — see `docs/LABELLING.md`. Ground truth comes from
  the video, never from the pipeline's output or from an LLM reading the
  description; labels derived from the thing being measured cannot measure it.
- **Changing the recipe contract** means adding a fixture to
  `packages/schema/fixtures/`, watching both suites fail, then changing both
  `packages/schema/src/recipe.ts` and `apps/extractor/app/schema.py`. Never one
  without the other.
- `apps/extractor` — pytest with golden-file fixtures in `tests/fixtures/`.
  Warnings are errors (`filterwarnings = ["error", ...]`); the single documented
  exception is the Starlette/httpx2 TestClient deprecation. Pipeline stages get
  synthetic fixtures in tests, then a manual run against the real cached
  descriptions in `scripts/spike_output/` as a sanity check — that second step
  is what caught the NFKC fraction bug and confirmed zero ingredient lines were
  being dropped.
- **Generated code is never linted or formatted.** `app/gen/` and
  `src/gen/` are excluded from ruff and eslint: CI compares the tree against
  fresh codegen output, so a formatter rewriting a stub would fail that check
  on every run with no way to fix it.
- `apps/web` — Playwright for cook-mode flows only. Don't unit test React.
  `pnpm test` is still a no-op there; the Playwright specs are outstanding.
- **Relative imports in `packages/*` carry no `.js` suffix.** tsc accepts both
  under `moduleResolution: bundler`, but Next's webpack does not map `.js` back
  to `.ts`, so a suffixed import builds under typecheck and fails the build.

## Style

- Conventional commits.
- One ADR per irreversible decision, in `docs/adr/`. Write the ADR *after* the
  decision, from the actual diff — retroactive ADRs are more honest than
  aspirational ones.
- Keep `docs/METRICS.md` and `docs/INCIDENTS.md` current. Every outage and every
  bug that reached a user goes in INCIDENTS.md.

## Working with Claude Code in this repo

- Start each session by reading this file and the relevant ADRs.
- Ask for a plan before implementation on anything touching more than two files.
- Ask before adding any dependency not already in `BUILD_PLAN.md`.
- Use `/clear` between phases; long contexts degrade on refactoring work.

## Known deviations from BUILD_PLAN.md

- **Next 15, not 16.** `create-next-app@latest` now ships Next 16.3.1; pinned to
  15.5.23 to match the plan. Bumping to 16 lets `apps/web/eslint.config.mjs`
  drop its `FlatCompat` shim.
- **Node 20 is EOL.** Next 15 supports it, but Phase 1 should move to Node 22
  LTS before CI is pinned to a version.
- **Gemini, not Anthropic.** The plan named no vendor and the first
  `.env.example` guessed Anthropic. See `docs/adr/0002-llm-provider.md`; the
  provider sits behind `LlmProvider`, so swapping is one new class.
