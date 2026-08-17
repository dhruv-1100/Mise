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
**Timeline:** UTC timestamps, detection through resolution.
**Root cause:** the actual cause, not the proximate symptom.
**Fix:** what was changed.
**Prevention:** the test, alert, or guardrail added so this class of failure
surfaces itself next time.
```

---

_No incidents yet — nothing is deployed._
