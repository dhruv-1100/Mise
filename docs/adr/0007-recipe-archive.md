# 0007 — A durable tier under the cache, on AWS

- **Status:** Accepted
- **Date:** 2026-10-20
- **Phase:** 4 (queue), closing a durability gap; part of Phase 7's alerting
- **Builds on:** ADR 0005 (Cloud Run topology)

## Decision

Extracted recipes are written to **S3** as well as Redis. Reads go Redis → S3 →
re-extract. The service reaches AWS by **federating its own GCP identity**; no
access key exists. The dead-letter queue's depth is published to CloudWatch,
where an alarm mails through SNS when it rises above zero.

## Context

Redis is a cache. `CACHE_TTL_SECONDS` expires a recipe after seven days, which
is the correct behaviour for a cache and was the wrong behaviour for the only
copy of the data.

On **2026-09-08** the live recipe page returned 404 twice in one session because
the entry for an already-extracted video had aged out. Each recovery cost a
**90–295 second** re-extraction and a Gemini call to produce a recipe that had
been extracted correctly a week earlier. The same thing had happened on
2026-08-31. Nothing was lost permanently — the pipeline is deterministic enough
to re-derive it — but the system was paying model time to recompute a fact it
had already established, and a reader hitting the page in between saw a 404.

An extraction is expensive and a recipe is small. That is the shape of thing
object storage exists for.

## What this is not

It is **not** "job outputs delivered by presigned URL", which was the shape
originally proposed. A recipe is roughly 7 KB and is already served over gRPC in
under a second; putting it behind a presigned redirect would add a hop and a
round trip to deliver a document smaller than the headers describing it. The
question "why is a 7 KB JSON blob behind a presigned URL?" has no good answer,
and a design whose only justification is that it uses a particular service is
worse than not using the service.

The durability problem is real, was observed twice, and S3 is the right answer
to it. That is the whole reason AWS appears in this project.

## Federation, not keys

`infra/github.tf` already exchanges a GitHub OIDC token for Google credentials
so CI can deploy without a service-account key. This is the same trick pointed
the other way: the container asks the GCP metadata server for an identity token
naming its own service account, and AWS STS exchanges it for short-lived
credentials.

Three details carry the security:

- **`accounts.google.com` is a built-in AWS identity provider.** No
  `aws_iam_openid_connect_provider` resource is created; registering one would
  fail as a duplicate.
- **The trust policy pins `accounts.google.com:sub` to the service account's
  numeric unique id**, not its email. An email-based condition silently widens
  if the account is ever deleted and recreated under the same name.
- **It also pins `:aud`** to an audience defined once in `locals` and used both
  by the policy and by the container requesting the token. Two definitions would
  drift, and the symptom is an opaque `AccessDenied` that names neither side.

The IAM policy grants `s3:GetObject` and `s3:PutObject` under one prefix, plus
`cloudwatch:PutMetricData` scoped to one namespace. No `ListBucket` — the
service has no reason to enumerate the archive. No `DeleteObject` — bucket
versioning already covers overwrite mistakes, and nothing in the system has a
reason to remove a recipe.

## Best-effort, enforced at the call site

Both archive calls are wrapped in `ExtractionQueue`, not only inside
`S3Archive`. That looks redundant and is not: `RecipeArchive` is a `Protocol`,
and a Protocol cannot require an implementation to be best-effort. Guarding
where it is called makes the guarantee true for every implementation rather than
for the one that remembered.

The rule it enforces: **an optional durability tier must never be able to fail
an extraction that has already succeeded.** By the time the archive is written
the recipe is correct, cached, and on its way to the caller.

## Configuration is all-or-nothing

Four environment variables, or none. None means `NullArchive` and the system
behaves exactly as it did before — which keeps a deployment without an AWS
account working, as BUILD_PLAN §6.1 requires of the public surface generally.

A *partial* configuration raises at startup rather than degrading quietly.
Degrading would hide the mistake for as long as the cache holds — months of
normal operation, then one inexplicable 404 when an entry finally expires. That
is precisely the failure this tier was built to remove, so it must not be the
failure the tier introduces.

## The dead-letter alarm

`ExtractionQueue.dead_letter_depth()` has existed since Phase 4 carrying the
docstring *"Non-zero is a Phase 7 alert: work was accepted and never done"*.
Nothing read it. A non-empty DLQ is the worst state this queue has — silently
wrong, no error anywhere, a reader waiting for a recipe that will never arrive —
and it was the one state with no alarm.

It rides on the archive's credentials: same role, same assume-role cycle. Two
independent federation loops would double the STS calls to reach the same place.

`treat_missing_data = "notBreaching"` is required rather than conventional. The
service scales to zero (ADR 0005), so most periods legitimately have no
datapoint, and treating missing data as a breach would page on an idle service.

## Consequences

- **This is not the start of a metrics layer.** Phase 7 brings Prometheus and
  Grafana for request counters, latency histograms and traces. This is one
  gauge, on infrastructure the archive already federates into, because the gap
  it closes is older than the plan for closing it.
- **A publishing outage is silent.** `notBreaching` means an alarm that cannot
  receive data does not fire. Monitoring the monitor is out of scope here and
  belongs with the Phase 7 work.
- **Cost.** One small bucket, a handful of objects per day, one custom metric.
  Within the free allowances at this volume, but AWS billing is not free by
  default — set a budget alert before applying.
- **`terraform apply` now needs AWS credentials** alongside the existing five
  providers. The running service still needs none.

## Addendum, 2026-10-20 — the scope was too narrow

This ADR scoped the archive to cache *expiry*: a recipe aging out of a Redis
that is otherwise healthy. Four days after it was written, Upstash deleted the
free-tier database for fourteen days of inactivity and the distinction turned
out to matter enormously.

`cached_recipe` read Redis unguarded before falling through, so an unreachable
database raised `ConnectionError` out of the servicer and the archive was never
consulted.

**Correction, written later the same day.** The paragraph that stood here said
the recipes were "sitting durably in S3" and called the tier "present, correct,
and bypassed". None of that was true. The bucket was empty. The federation
described below under *Federation, not keys* had never once succeeded, and the
archive had written nothing since the day it shipped — see the second
2026-10-20 entry in `docs/INCIDENTS.md`. The tier was present, misconfigured,
and silent.

That correction is left visible rather than edited away, because the mistake is
instructive: the addendum above was written from the code and the design, both
of which were sound, without checking the bucket. `scripts/verify_aws.py` was
sitting in the repository, written for exactly this, unrun. Reasoning about
infrastructure is not evidence about infrastructure.

Both Redis calls in the read path are now guarded, and the guarantee is wider
than it was: **a dead cache degrades to slower, not to down.** Reads fall
through to S3; writes still fail loudly, because a queue that accepts a job it
cannot store has lost the job silently.

Two things follow that were not obvious when this was written:

- **`Health` cannot be the signal.** It returned `ok` throughout, exactly as
  the rpc comment in `extractor.proto` promises — liveness only, so an
  orchestrator cannot restart a healthy service because Redis is slow. That
  design is still right. It simply means something else has to ask.
- **The fix removed the deploy gate's only Redis check.** Falling through to
  the archive means `GetRecipe` answers `found: false` whether the cache is
  empty or absent, so `smoke_grpc.py`'s documented claim that "a missing
  `REDIS_URL` fails here" quietly became false. It now also calls `GetStatus`,
  whose `queue.get` reads Redis unguarded, making `NOT_FOUND` the proof that
  Redis answered. A resilience change that blinds a monitor is a bad trade, and
  it was nearly made silently.

`docs/INCIDENTS.md` has the full timeline.

## Addendum, 2026-10-20 — region is a constraint, not a choice

`var.aws_region` now defaults to `us-east-2`. The AWS account is a member of an
organization it does not control, whose service control policy denies regional
services everywhere else; an apply at the previous `us-east-1` default failed
with an explicit SCP deny on `s3:CreateBucket` and `SNS:CreateTopic` while the
IAM role in the same run succeeded, IAM being global.

This constrains any future move. The bucket cannot be relocated to sit nearer
Cloud Run's `us-east1` without the organization's policy changing, so the
cross-region hop on an archive read is fixed cost rather than something to tune.
At one GET on a cache miss it does not matter; it would matter if this ever
became a hot path, and it cannot become one by design.

## Addendum, 2026-10-20 — `oaud`, not `aud`

The trust policy under *Federation, not keys* pinned
`accounts.google.com:aud` to the token audience. That condition can never match.
For the built-in `accounts.google.com` provider AWS maps `:aud` to the token's
`azp` claim when one is present, falling back to `aud`; Google service account
identity tokens do carry `azp`, set to the account's numeric unique id. So AWS
was comparing `116924920265042331650` against `mise-extractor-aws`.

`accounts.google.com:oaud` maps to `aud` unconditionally and is correct either
way. `:sub` is unchanged and remains the actual security boundary — the audience
condition stops a token minted for another purpose being replayed, it does not
decide who may assume the role.

The failure mode is worth recording separately from the fix. AWS returns
`AccessDenied: Not authorized to perform sts:AssumeRoleWithWebIdentity` with no
mention of which claim, which condition or what value it compared, so a trust
policy that is one key away from correct is indistinguishable from a missing
permission. Anyone debugging this will reasonably start with IAM grants, and
they will be looking in the wrong place.
