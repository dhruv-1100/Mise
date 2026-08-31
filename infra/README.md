# Infrastructure

Terraform for Neon (Postgres), Upstash (Redis), Vercel (web), Cloud Run
(extractor), and Grafana Cloud (metrics).

**Status: all five providers are applied and live. `terraform plan` is clean.**

| Provider | State | Detail |
| --- | --- | --- |
| Neon | live | `mise-prod` (`curly-recipe-02809405`), db `mise`, role `mise_app`, PG 17.10, pgvector 0.8.0 |
| Upstash | live | global Redis, primary `us-east-1`, TLS, eviction off |
| Vercel | live | project `mise-prod`, Next.js, root `apps/web`, linked to `dhruv-1100/Mise@main` |
| Grafana | live | stack `miseprod` at `prod-us-east-3`, metrics-write policy + token, verified against the Prometheus endpoint |
| Cloud Run | live | `mise-prod-extractor` in `mise-505819`/`us-east1`, scale-to-zero, dedicated service account, Artifact Registry repo `mise-prod` |

Cloud Run required a billing account on the project even to stay inside the free
tier — GCP refuses to provision the service without one. That is an account
prerequisite rather than a cost: the free allowance still applies and the
service scales to zero.

Railway was dropped, not deferred. The token was valid and listed projects, but
`projectCreate` returned "Your trial has expired. Please select a plan" —
Railway has no free tier. `BUILD_PLAN.md` §1.1 named Fly.io as the alternative;
Cloud Run was chosen instead because it scales to zero and extraction is bursty,
so an always-on machine would be paying to idle.

Until the last two exist, apply with `-target`; an untargeted `plan` reaches
every provider and fails on placeholder tokens.

Three things the real applies surfaced that neither `validate` nor `plan` could
see, all now fixed. The pattern is worth internalising: schema validation knows
attribute names and types, and knows nothing about quotas, deprecations, or
account state.

- **`history_retention_seconds` was 86400.** The free tier caps it at **21600**
  (6 hours) and the API returns a 400 above that. Quotas are server-side; schema
  validation cannot know them.
- **Upstash regional databases are deprecated.** `region` must now be
  `"global"`, with the old value moving to `primary_region`; a regional value
  returns a 400. A global database is one primary plus optional read replicas.
- **Deleting a Grafana stack can invalidate the token that deleted it.** On the
  free tier the org slug and the stack slug are the same string, and an access
  policy scoped to that stack dies with it. Deleting `gracefullichen3169` to
  free the one-stack quota immediately turned a working `glc_` token into
  `401 InvalidCredentials`, so Terraform could not then create the replacement.
  Create the access policy with **Realm: Org**, and expect to reissue the token
  after deleting a stack regardless.
- **Grafana tokens carry their region, and it is not opaque.** `glc_` tokens are
  base64; the `m.r` field is the region the token was issued for.
- **Grafana has two region vocabularies, and the obvious pairing is wrong.**
  Stacks take a slug (`prod-us-east-3`); access policies take a region that, for
  a **stack-realm** policy, must equal the stack's slug — *not* the coarse `us`
  in the token. Getting it wrong returns 409 "Stack must be in region us",
  which reads like a stack problem and is a policy-region problem. An org-realm
  policy accepts either, but would grant the metrics token access to every stack
  in the account. Hence two separate variables.
- **A Railway token that fails `me` is not necessarily invalid.** Workspace
  tokens cannot query `me` and must be tested with a workspace-scoped query such
  as `projects`. Diagnosing on `me` alone reports a working token as broken.
- **Organization API keys need an explicit `org_id`.** A personal key does not.
  If `/users/me` and `/regions` return 401 while `/projects` works, the key is
  an organization key. Get the id with:

  ```bash
  curl -H "Authorization: Bearer $NEON_API_KEY" \
    https://console.neon.tech/api/v2/users/me/organizations
  ```

## Usage

```bash
export TF_VAR_neon_api_key=...
export TF_VAR_upstash_email=...
export TF_VAR_upstash_api_key=...
export TF_VAR_vercel_api_token=...
export TF_VAR_youtube_api_key=...
export TF_VAR_gemini_api_key=...
export TF_VAR_grafana_cloud_access_policy_token=...

cp terraform.tfvars.example terraform.tfvars   # non-secret values only

terraform -chdir=infra init
terraform -chdir=infra plan
terraform -chdir=infra apply
```

Read a credential out afterwards:

```bash
terraform -chdir=infra output -raw database_url
```

## Where to get each token

| Provider | Token | Where |
| --- | --- | --- |
| Neon | API key | console.neon.tech → Account settings → API keys |
| Upstash | Management API key | console.upstash.com → Account → Management API |
| Vercel | API token | vercel.com/account/tokens |
| Google Cloud | Application Default Credentials | `gcloud auth application-default login`, or a service-account key |
| Grafana | Access policy token | grafana.com → Security → Access policies (needs `stacks:read`, `stacks:write`) |

## Things worth knowing before you apply

### pgvector is not provisioned here, and cannot be

The Neon Terraform provider exposes **no** extension resource — verified
against the v0.15.0 schema: there is no `neon_extension`, and `neon_project`
has no `extensions` attribute. `BUILD_PLAN.md` §1.1 asks for "a Neon Postgres
project with pgvector enabled"; the first half is Terraform's job and the
second half is not.

pgvector gets enabled in SQL, in the first migration — which is written and has
been applied:

```bash
psql "$(terraform -chdir=infra output -raw database_url)" \
  -f apps/extractor/migrations/0001_enable_pgvector.sql
```

Confirmed live: `vector` 0.8.0.

### Two of the five providers are not official

| Provider | Source | Status |
| --- | --- | --- |
| Vercel | `vercel/vercel` | Official |
| Upstash | `upstash/upstash` | Official |
| Grafana | `grafana/grafana` | Official |
| Google | `hashicorp/google` | Official |
| **Neon** | `kislerdm/neon` | **Community.** Neon publishes no official provider. |


This matters in two ways. Practically, a community provider can break between
minor versions, which is why `versions.tf` pins with `~>` and
`.terraform.lock.hcl` is committed. And if you say "provisioned via Terraform"
in an interview, be ready for "which providers?" — the honest answer is that
only Neon is community-maintained, and knowing which is a better signal than
not.

### `database_url` is the app role, not the project owner

`neon_project.connection_uri` points at the project's **default** database and
owner role (`neondb` / `neondb_owner`), not the ones declared in `neon.tf`.
Using it would mean the application connects to the wrong database as a
high-privilege role, which defeats creating a least-privilege role at all.

The `database_url` and `database_url_pooled` outputs build the real connection
string for `mise_app` against `mise`. `owner_database_url` exposes the owner
credential for migrations and admin, and should never reach the application.

### Cloud Run's image is CI's, everything else is Terraform's

The service is declared with `gcr.io/cloudrun/hello` and a
`lifecycle { ignore_changes = [image] }` block. That is not a leftover: CI owns
the image and Terraform owns everything around it, and without the ignore rule
every `terraform apply` would roll production back to hello-world.

The first `apply` on a fresh project therefore creates a service running
hello-world, and the first `deploy.yml` run replaces it. If you are wondering
why the extractor URL returns a Google welcome page, that is why — deploy has
not run yet.

### State is local

`terraform.tfstate` lives on disk and is gitignored. That is fine for one
operator and wrong the moment a second person or CI runs `apply`, because local
state cannot be locked and two concurrent applies will corrupt it.

Note that state contains **every credential in plaintext**, including the
database password and the Grafana token. Do not commit it, and do not paste it
anywhere.

Move to a remote backend before CI ever applies.

### Free tiers

Everything targets a free tier. Total should sit near $0–15/month, which is
itself a number worth reporting. Things that would change it: Upstash
autoscaling, Neon history retention beyond the free cap, Cloud Run traffic past
the monthly free allowance, and any Grafana Cloud usage past the free metric
series limit.

## Deploying

`.github/workflows/deploy.yml` builds the extractor image and rolls a Cloud Run
revision after CI passes on `main`. It authenticates with Workload Identity
Federation, so **there is no service account key to create or store** — see
`infra/github.tf` and `docs/adr/0005-cloud-run-topology.md`.

After `terraform apply`, set six **repository variables** (Settings → Secrets
and variables → Actions → Variables). None is a secret; that is the point.

```bash
terraform -chdir=infra output -raw github_wif_provider              # GCP_WIF_PROVIDER
terraform -chdir=infra output -raw github_deployer_service_account  # GCP_DEPLOYER_SA
terraform -chdir=infra output -raw extractor_service_name           # EXTRACTOR_SERVICE
terraform -chdir=infra output -raw extractor_image_repo             # EXTRACTOR_IMAGE_REPO
```

plus `GCP_PROJECT_ID` and `GCP_REGION`, which match your `terraform.tfvars`.

The workflow finishes by making one real gRPC call against the deployed URL. A
green `gcloud run deploy` only proves the container bound its port; the smoke
test proves the BFF could actually talk to it.

To deploy without waiting for a merge, run the workflow manually
(Actions → Deploy → Run workflow).

## The web app deploys itself

Vercel builds from the GitHub integration on every push, so no workflow deploys
the frontend. What it needs is configuration, and `infra/vercel.tf` now sets it:
`DATABASE_URL` and `EXTRACTOR_GRPC_ADDRESS` are wired from the Neon and Cloud
Run resources directly, so they cannot go stale when an endpoint changes.

The rest are variables you must supply in `terraform.tfvars`, and each is
skipped when empty rather than written blank:

| Variable | Where it comes from |
| --- | --- |
| `auth_secret` | `openssl rand -base64 32` |
| `google_oauth_client_id` / `_secret` | GCP console → APIs & Services → Credentials → OAuth client ID (Web application) |
| `site_url` | your Vercel production URL |
| `posthog_key` | PostHog → Project settings → Project API key |

A blank `AUTH_SECRET` is worse than an absent one: Auth.js would start and sign
tokens with it. Absent, it refuses to start.

### Turning accounts on

The app is deployed at https://mise-prod.vercel.app and everything except
accounts works there. `/api/auth/providers` currently returns Auth.js's
server-configuration error, which is what a missing secret and a missing
provider look like from outside.

Only one of the four values needs creating; the rest are a command and a URL.

**1. A Google OAuth client.** GCP console -> APIs & Services -> Credentials ->
Create credentials -> OAuth client ID -> Web application. The redirect URI is
the part people get wrong, and Google matches it exactly:

```
https://mise-prod.vercel.app/api/auth/callback/google
```

Add `http://localhost:3000/api/auth/callback/google` as a second one if you want
sign-in to work in `next dev` too. `/api/auth/callback/google` is Auth.js's own
route, not something this repo chose, so it cannot be renamed.

The base sign-in asks only for `openid email profile` — no consent screen review
needed. The `youtube.readonly` scope for claiming a channel is requested
separately and only when someone claims (ADR 0003), and *that* is the one that
needs Google verification past 100 users.

**Use the console's copy button — do not select the text, and never retype it.**
This went wrong twice here. The first paste wrapped and arrived with newlines, a
space and a pipe in it. The second was reconstructed by hand from that broken
value and dropped the character the pipe had replaced: 31 of the 32 characters
Google issues, perfectly well-formed, and non-existent. Google answers "The
OAuth client was not found", which reads like a deleted client rather than a
typo. The variable now asserts the exact length.

**Copy the client ID and secret carefully.** A value pasted across a wrapped
terminal arrives with newlines and spaces inside it, Terraform stores it, Vercel
serves it, and the only symptom is Google answering `Error 401: invalid_client`
on a page that explains nothing. That happened here. Both variables now have a
format check that fails at `terraform apply` instead, but the easiest guard is
to paste into a text editor first and confirm it is one unbroken line:

```
123456789012-abc123def456ghi789jkl.apps.googleusercontent.com
```

**2. A signing secret.**

```bash
openssl rand -base64 32
```

**3. Apply.** These are variables like any other, so pass them however you pass
`TF_VAR_neon_api_key` — environment or `terraform.tfvars`:

```bash
export TF_VAR_auth_secret='...'
export TF_VAR_google_oauth_client_id='....apps.googleusercontent.com'
export TF_VAR_google_oauth_client_secret='...'
export TF_VAR_site_url='https://mise-prod.vercel.app'
terraform -chdir=infra apply
```

Terraform writes all four to Vercel, and **Vercel needs a redeploy to pick up
new environment variables** — an empty commit to main, or Redeploy in the
dashboard. Env vars are not applied to an existing build.

**4. Check it.** `curl https://mise-prod.vercel.app/api/auth/providers` should
list Google instead of returning the configuration error.

These target **production and preview only, never development**. Vercel's
development environment is the one `vercel env pull` writes to a local file, so
the provider refuses to mark anything targeting it sensitive — and the fix is
not to unmark them. Local development reads the repo's own `.env`; see
`.env.example`.

## What is deliberately not here

- **DNS / custom domains.** No domain registered yet.
- **Secret Manager.** The Cloud Run service carries its API keys as plain
  environment values, readable by anyone with console access to the project.
  Moving them behind Secret Manager is Phase 8's security pass.
- **A remote state backend.** Still local, still unlocked — see below.
