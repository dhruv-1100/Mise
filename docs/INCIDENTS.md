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
