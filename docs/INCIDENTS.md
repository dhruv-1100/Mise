# Incidents

Every outage, and every bug that reached a user: what broke, how it was found,
how it was fixed, and what changed so it does not recur.

Kept from day one deliberately. A blameless incident log is worth more in an
interview than any feature in this repo.

## Template

```markdown
## YYYY-MM-DD — one-line summary

**Impact:** who was affected, for how long, how badly.
**Detected by:** alert / user report / noticed by accident. Be honest — "noticed
by accident" is the finding that matters.
**Root cause:** the actual cause, not the proximate symptom.
**Fix:** what was changed.
**Prevention:** the test, alert, or guardrail added so this class of failure
surfaces itself next time.
```

---

## 2026-08-18 — CI's Python job never ran, for ten consecutive runs

**Impact:** No users; nothing is deployed. The `extractor (Python)` job failed
at setup on every run from the moment CI was introduced, so ruff and 162 pytest
tests were never executed on any pull request. Five PRs merged to `main` with
that job red. The damage was not a broken build — it was that a gate everyone
was trusting had never once closed.

**Detected by:** Not by the red X, which is the finding worth keeping. Five PRs
were merged while every run was failing. It surfaced only when a status review
queried the Actions API and found ten runs and ten failures.

**Root cause:** `astral-sh/setup-uv@v10`. That action publishes no moving major
tag — only exact releases such as `v10.0.1` — so the reference could not resolve
and the job died before running a step.

The reference was written during a commit that bumped four actions to newer
majors. The original versions were each verified to exist; the bumped versions
were applied with `sed` and never re-checked, and the commit message stated the
versions had been verified. The check ran against the content before the change
it was meant to validate.

**Fix:** All five actions pinned to exact released versions, each confirmed to
resolve against the GitHub API before being written.

**Prevention:**

- Exact pins rather than major tags. A major tag that exists today can also be
  deleted; an exact tag cannot drift.
- The real lesson is sequencing, not syntax. Verification has to run after the
  edit, and a commit message must not claim a check that was performed against
  different content.
- Branch protection requiring CI to pass, so a red run blocks the merge instead
  of relying on somebody noticing.

**Open:** Branch protection is not enabled on `main`, which is why five PRs
could merge past a failing check. It has to be set in the repository settings
and cannot be committed to the repo.

---

## 2026-08-28 — first deployed revision crash-looped: `No module named 'google.protobuf'`

**Impact:** No users — nothing was public yet. The extractor's first two real
Cloud Run revisions (`00003`, `00004`) never became ready, so the service kept
serving the `gcr.io/cloudrun/hello` placeholder and every gRPC call returned
UNAVAILABLE. Roughly ten minutes of deploy attempts, entirely self-inflicted.

**Detected by:** A failing deploy job whose error was misread twice before the
container logs were read. The job said only "Process completed with exit code 1"
and the Docker build step was green, which sent the first two hypotheses in the
wrong direction — including one about IPv6 binding that a test then disproved.
The revision list and `gcloud run services logs read` gave the answer in one
line. **Read the logs before forming the third hypothesis.**

**Root cause:** `app/gen/extractor_pb2.py` imports `google.protobuf` directly,
but `protobuf` was never declared in `apps/extractor/pyproject.toml`. It reached
the development environment transitively through `grpcio-tools`, a **dev**
dependency needed only by `scripts/codegen.sh`. The Dockerfile builds with
`uv sync --frozen --no-dev`, which correctly excluded it — so the module was
present for every local run, every test, and every CI job, and absent in the
only environment that mattered.

The identical hazard was already understood in this repo. Four lines above where
the fix went, `pyproject.toml` says of httpx: *"depending on someone else's
dependency graph is how a working build breaks on an unrelated upgrade."* The
rule was written down and not applied to the generated stubs.

A second, independent bug was found while chasing this one:
`scripts/smoke_grpc.py` could never have run at all — it lacked the `sys.path`
shim its two sibling scripts carry, so it died on its import line. It was
written into `CLAUDE.md` as a documented command without being executed once.
That is the sequencing lesson from the 2026-08-20 entry recurring: verification
claimed rather than performed.

**Fix:** `protobuf>=7.35.1` declared as a runtime dependency — the floor comes
from the `ValidateProtobufRuntimeVersion` call the generated stub makes, so it
is not a guess. `sys.path` shim added to the smoke script.

**Prevention:** A CI step that installs the container's dependency set and
imports the production entrypoint:

```yaml
- name: Runtime dependencies are sufficient without dev
  env:
    UV_PROJECT_ENVIRONMENT: .venv-runtime
  run: |
    uv sync --frozen --no-dev
    uv run --no-dev --frozen python -c "import app.server"
```

Tested against a planted regression in both directions: with `protobuf` removed
from `pyproject.toml` it fails, with it declared it passes. Twenty seconds, and
it closes the whole class — any runtime import that only a dev dependency
supplies now fails on a pull request instead of in a crash loop.

**Open:** Nothing catches this for `apps/web`. Vercel installs dev dependencies
during its build, so a Next.js runtime import satisfied only by a devDependency
would behave the same way. Worth the equivalent check in Phase 8's hardening.

---

## 2026-10-20 — Upstash deleted the Redis database for inactivity; the extractor was hard-down and nothing noticed

**Impact:** Every queue-backed operation failed for an unknown period, ending
roughly 14+ days after the last traffic. `Extract`, `GetStatus`, `StreamStatus`
and `GetRecipe` all returned `UNKNOWN`, so the live site could neither extract a
new video nor serve one it had already extracted. The web app itself and the
Neon database were unaffected. No user other than the author was exercising the
system, which is the only reason this is a footnote rather than an outage report
with a customer on the end of it.

**Detected by:** Noticed by accident, during unrelated Terraform work. `plan`
failed with `Get Redis Database failed, status code: 404` and the question
"why is Terraform confused" turned out to be "production is down". The duration
above is unknown precisely *because* nothing was watching — there is no first
failing timestamp to point at.

Upstash did send an inactivity warning by email beforehand. It was read after
the fact.

**Root cause:** Not a bug. Upstash deletes a free-tier database after 14 days
without traffic — stated in the console, and the mail had warned about it. Mise
is a portfolio project that legitimately goes a fortnight between visits, so the
hosting tier's assumptions and the project's usage pattern were in direct
conflict and nothing reconciled them.

Two secondary findings, both worse than the cause:

1. **`Health` returned `ok` throughout.** That is exactly what it promises —
   liveness only, so an orchestrator cannot restart a healthy service because
   Redis is slow (`extractor.proto`). The design is right. The gap was that
   nothing *else* ever asked a question whose answer depended on Redis.
2. **The S3 archive would not have helped.** ADR 0007 scoped it to cache
   *expiry*, and `cached_recipe` read Redis unguarded before falling through.
   A `ConnectionError` propagated out of the servicer, so recipes sitting safely
   in S3 were unreachable for the entire outage. The durable tier was present,
   correct, and bypassed.

**Fix:** Database recreated through Terraform. The provider 404s on a missing
resource instead of planning a replacement, so recovery needed
`terraform state rm upstash_redis_database.main` first. The cache was lost;
nothing in it was durable by definition.

In code, `cached_recipe` now guards both its Redis calls — the read, and the
re-warm that follows a successful archive hit. Reads degrade to "slower"; writes
still fail loudly, because a queue that accepts a job it cannot store has lost
the job silently.

**Prevention:** `.github/workflows/canary.yml` — one real RPC against production
daily. It is both halves of the problem at once: the traffic that resets the
14-day clock, and the alarm that goes off the next time something breaks without
anyone watching.

That required fixing a trap the resilience work had just set. Falling through to
the archive meant `GetRecipe` could no longer fail because of Redis — it answers
`found: false` whether the cache is empty or absent. The deploy smoke test's
own docstring claimed "a missing `REDIS_URL` fails here", and as of the guard
that was false. `smoke_grpc.py` now also calls `GetStatus` with a job id nothing
ever created: `queue.get` reads Redis unguarded, so `NOT_FOUND` proves Redis
answered and anything else proves it did not. Verified against a real gRPC
server backed by a failing Redis — exit 1 — and a working one — exit 0.

**Open:**

- The canary is not absolute. GitHub disables scheduled workflows in a
  repository with no pushes for 60 days, so a long enough gap in commits
  disables the thing protecting against long gaps.
- Nothing watches Neon, Vercel or the free tiers' equivalent policies. The same
  class of failure is available from three other providers.
