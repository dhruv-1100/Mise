# 0005 — Deploying the extractor: one process, one port, no keys

- **Status:** Accepted
- **Date:** 2026-08-26
- **Phase:** 1 (completing the deployment left unfinished) / 6 exit criteria
- **Supersedes:** the placeholder `gcr.io/cloudrun/hello` image in
  `infra/cloudrun.tf`, and the assumption in the Dockerfile that the deployed
  container serves HTTP.

## Decision

The extractor container runs **`app.server`**: the gRPC surface bound to
`$PORT`, and the worker pool in the same process. The FastAPI app is no longer
reachable in production. The service **scales to zero**. CI authenticates to
Google with **Workload Identity Federation**, holding no key.

## Context

Phase 4 built a gRPC server and a worker pool, tested both, and wired the BFF to
gRPC. Nothing ever started either one outside a test: `Dockerfile` ran
`uvicorn app.main:app`, and `serve()` and `run_pool()` had no caller. A Cloud
Run revision built from that image would have answered its health probe, served
HTTP nobody talks to, and failed every request the BFF made — while looking
healthy on every dashboard.

That is the failure this ADR exists to prevent recurring, and it is worth naming
the class: **a component that is well tested and never invoked.** Unit tests
cannot catch it, because the unit works. `tests/test_server.py` now boots the
real entrypoint, speaks gRPC to it over a socket, and sends it SIGTERM.

## One process, one port

Cloud Run routes traffic to exactly one port per container. The BFF speaks gRPC,
so gRPC takes the port and the HTTP surface stays a local development path
(`POST /extract`, as CLAUDE.md documents it).

Two consequences that are easy to get wrong:

- **The port must be named `h2c`.** Cloud Run terminates TLS at its frontend and
  forwards cleartext HTTP/2 only when the port carries that name. Without it the
  frontend downgrades to HTTP/1.1, which cannot carry gRPC — and the symptom is
  a channel that connects and then fails every call, not a startup error.
- **The startup probe is TCP, not HTTP.** `GET /healthz` against a gRPC server
  is a protocol error, so the old probe would have failed every revision.
  Probing gRPC properly means registering `grpc.health.v1` and adding
  `grpcio-health-checking`; a TCP connect proves what this needs — the process
  is up and bound — with no new dependency.

## The worker, and what scaling to zero costs

Cloud Run throttles a container's CPU to near-zero between requests unless CPU
is always allocated, which is billed by the instance-hour. The worker pool
therefore only makes progress while some request is holding the instance awake.

In practice that window is the right one: the BFF opens `StreamStatus`
immediately after `Extract` and holds it for the life of the job, which is
exactly when the worker needs CPU.

**The failure mode this leaves is real.** If every client disconnects
mid-extraction — the tab is closed, the phone sleeps — the job stalls until some
later request wakes an instance, at which point the worker claims it again and
finishes it. Nothing is lost; it is late.

This was chosen deliberately over `min_instance_count = 1` with CPU always
allocated, which drains the queue continuously and costs roughly $15–20/month.
At the current scope — a personal tool, one user, extractions started
interactively and watched — paying to idle buys nothing. The upgrade is a
one-line Terraform change and this paragraph is the note explaining when to make
it: **when a job stalling until the next visit stops being acceptable**, which
is the moment anyone other than the operator uses it.

## No key in the repository

The obvious way to let GitHub Actions push to Artifact Registry is a service
account JSON key in a repository secret. That key never expires, exists in
plaintext wherever the secret is read, and rotating it is a manual job nobody
remembers. Workload Identity Federation exchanges GitHub's own signed OIDC token
for a short-lived credential per run, and stores nothing on either side.

The security boundary is one line — `attribute_condition` in
`infra/github.tf`. Without it the provider trusts **every** token GitHub issues,
which means any workflow in any public repository can obtain credentials to this
project. It is pinned to this repository.

Permissions are scoped rather than project-wide: `artifactregistry.writer` on
one repository, `run.developer` on one service, and `iam.serviceAccountUser` on
the runtime account — the last being the one whose absence produces the deploy
error everybody hits once.

## Deploy only what CI passed

`deploy.yml` triggers on `workflow_run` when CI completes on `main`, and checks
out the SHA that CI tested rather than the tip of the branch, which may already
have moved. Deploying on push instead would race CI and could ship a revision
whose tests were still running.

A green `gcloud run deploy` proves the container bound its port. It does not
prove the service works, so the workflow finishes by making one real gRPC call
over TLS against the deployed URL. That single request covers the address, the
TLS termination, the `h2c` forwarding, the servicer registration and — because
`GetRecipe` reads the cache — that Redis is reachable. Every one of those was a
live possibility when this was written, and none is visible from a green deploy.

## Consequences

- The FastAPI surface is dev-only. Anything that needs an HTTP endpoint in
  production (the Prometheus `/metrics` scrape in Phase 7) needs a decision:
  either a second Cloud Run service, or push-based metrics to Grafana Cloud.
  Push is the likelier answer, since a scale-to-zero service cannot be scraped.
- Environment variables are set as plain values on the service, readable by
  anyone with console access to the project. Secret Manager is the upgrade;
  it is not done here, and doing it is Phase 8's security pass.
- Terraform owns the service's configuration and CI owns only its image. The
  `lifecycle { ignore_changes = [image] }` block is what keeps `terraform apply`
  from rolling production back, and it must stay.
