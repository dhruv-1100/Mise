# Mise

## What this is

A web app that converts cooking videos into structured, scalable recipes.

**Status:** Phase 0 complete. Phase 2.1 complete — see
`docs/adr/0001-content-sourcing.md`; the headline is that captions are
unreachable without creator OAuth and descriptions are the primary source.
Phase 1 in progress: CI is written, Terraform is written and validates but has
never been applied. See `BUILD_PLAN.md` for all 12 phases.

## Architecture

- `apps/web` — Next.js 15 App Router, TypeScript, Tailwind 4. BFF pattern.
- `apps/extractor` — Python 3.12 + FastAPI, managed by uv. Owns all LLM calls
  and parsing. The web app never calls an LLM directly.
- `packages/scaling` — pure TypeScript, zero runtime deps, 100% branch coverage
  required (enforced from Phase 3).
- `packages/schema` — the recipe contract, as zod schemas with inferred types.
  Mirrored by hand in `apps/extractor/app/schema.py` (Pydantic); both are
  validated against the shared fixtures in `packages/schema/fixtures/`, which is
  what stops the two definitions drifting. `extractor.proto` and generated
  TS/Python stubs replace the mirror in Phase 4.
- `infra/` — Terraform (Phase 1).
- Postgres (Neon) with pgvector, Redis (Upstash) for cache + job queue — both
  Phase 1. Neither exists yet.

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
pnpm test               # vitest across packages (empty suites pass)
pnpm lint               # eslint across all workspaces
pnpm typecheck          # tsc --noEmit across all workspaces
```

```bash
cd apps/extractor
uv sync                 # once
uv run pytest
uv run ruff check
uv run ruff format
uv run uvicorn app.main:app --reload   # :8000
```

```bash
uv run scripts/spike_captions.py ID1 ID2   # Phase 2.1 spike (self-contained)
uv run scripts/spike_captions.py --replay-q4  # re-analyse cached text, 0 quota

terraform -chdir=infra init
terraform -chdir=infra validate
terraform -chdir=infra plan                # needs TF_VAR_* creds; see infra/README.md
```

## Testing

- `packages/scaling` — property-based tests via fast-check. Required. Write the
  tests first; this is the one component where correctness beats speed.
- **Changing the recipe contract** means adding a fixture to
  `packages/schema/fixtures/`, watching both suites fail, then changing both
  `packages/schema/src/recipe.ts` and `apps/extractor/app/schema.py`. Never one
  without the other.
- `apps/extractor` — pytest with golden-file fixtures in `tests/fixtures/`.
  Warnings are errors (`filterwarnings = ["error", ...]`); the single documented
  exception is the Starlette/httpx2 TestClient deprecation.
- `apps/web` — Playwright for cook-mode flows only. Don't unit test React.
  `pnpm test` is a documented no-op in `apps/web` until Phase 6.

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
- **No `@vitest/coverage-v8` yet.** The 100%-branch-coverage gate on
  `packages/scaling` needs it; add in Phase 1 with the CI workflow.
- **Node 20 is EOL.** Next 15 supports it, but Phase 1 should move to Node 22
  LTS before CI is pinned to a version.
