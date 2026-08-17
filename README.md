# Mise

Turn any cooking video into a structured, scalable recipe you can actually cook
from.

> **Status: Phase 0.** The repo is scaffolded and the toolchain runs. There is no
> product yet — no routes, no database, no extraction. See
> [`BUILD_PLAN.md`](BUILD_PLAN.md) for the 12-phase plan and
> [`CLAUDE.md`](CLAUDE.md) for the conventions that govern the code.

## Layout

```
apps/web         Next.js 15 App Router, TypeScript, Tailwind 4 — BFF
apps/extractor   Python 3.12 + FastAPI — owns all LLM calls and parsing
packages/scaling pure TypeScript scaling engine, zero runtime deps
packages/schema  shared types; protobuf definitions from Phase 4
infra            Terraform (Phase 1)
docs/adr         architecture decision records
scripts          throwaway spikes
```

## Setup

Requires Node ≥ 20.9, Python 3.12, and [uv](https://docs.astral.sh/uv/).

```bash
corepack enable pnpm
pnpm install
cd apps/extractor && uv sync && cd ../..
cp .env.example .env    # then fill in YOUTUBE_API_KEY
```

## Commands

| Command | What it does |
| --- | --- |
| `pnpm dev` | Next.js dev server on :3000 |
| `pnpm test` | vitest across packages |
| `pnpm lint` | eslint across all workspaces |
| `pnpm typecheck` | `tsc --noEmit` across all workspaces |
| `pnpm build` | production build |
| `uv run pytest` | extractor tests (from `apps/extractor`) |
| `uv run ruff check` | extractor lint (from `apps/extractor`) |

## Phase 2.1 — captions spike

The go/no-go on the whole project: can we get captions through the official API?

```bash
uv run scripts/spike_captions.py VIDEO_ID VIDEO_ID VIDEO_ID
```

Self-contained via PEP 723 inline dependencies, so it adds nothing to any
package manifest. Findings are recorded in
[`docs/adr/0001-content-sourcing.md`](docs/adr/0001-content-sourcing.md).

## Legal posture

Recipes — ingredient lists and functional steps — are not copyrightable in the
US. The creative expression around them is, and so are transcripts and
descriptions. Accordingly: official API only, structured extraction stored but
never raw transcripts, aggressive attribution with an embedded player on every
recipe page, and a creator-permissioned launch. Details in
[`docs/adr/0001-content-sourcing.md`](docs/adr/0001-content-sourcing.md).
