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

### Cloud Run starts on a placeholder image

`google_cloud_run_v2_service` needs an image at create time, and the real one
does not exist until CI has built it. The service is created on
`gcr.io/cloudrun/hello`, and `lifecycle.ignore_changes` covers the image field —
without that, every `terraform apply` would roll production back to
hello-world. CI owns the image from then on; Terraform owns everything else.

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

## What is deliberately not here

- **`deploy.yml`.** Nothing is provisioned, so there is nothing to deploy to.
- **DNS / custom domains.** No domain registered yet.
- **Environment variables on the Vercel project.** They would have to reference
  outputs that do not exist until after the first apply. Wire them in a second
  pass, once `terraform output` returns real values. The Cloud Run service does
  get its keys, because it cannot start without them.
