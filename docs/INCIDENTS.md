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
