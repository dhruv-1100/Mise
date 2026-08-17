# Infrastructure

Terraform for Neon (Postgres), Upstash (Redis), Vercel (web), Railway
(extractor), and Grafana Cloud (metrics).

**Status: written and `terraform validate`-clean, never applied.** No account
exists for Neon yet, and nothing here has been run against a real API. Expect
the first `plan` to surface things `validate` cannot see — region slugs, plan
eligibility, name collisions.

## Usage

```bash
export TF_VAR_neon_api_key=...
export TF_VAR_upstash_email=...
export TF_VAR_upstash_api_key=...
export TF_VAR_vercel_api_token=...
export TF_VAR_railway_token=...
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
| Railway | Account token | railway.app → Account → Tokens |
| Grafana | Access policy token | grafana.com → Security → Access policies (needs `stacks:read`, `stacks:write`) |

## Things worth knowing before you apply

### pgvector is not provisioned here, and cannot be

The Neon Terraform provider exposes **no** extension resource — verified
against the v0.15.0 schema: there is no `neon_extension`, and `neon_project`
has no `extensions` attribute. `BUILD_PLAN.md` §1.1 asks for "a Neon Postgres
project with pgvector enabled"; the first half is Terraform's job and the
second half is not.

pgvector gets enabled in SQL, in the first migration:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

Phase 10 is the first thing that needs it. Run it in Phase 6 anyway, so the
extension is in place long before anything depends on it.

### Two of the five providers are not official

| Provider | Source | Status |
| --- | --- | --- |
| Vercel | `vercel/vercel` | Official |
| Upstash | `upstash/upstash` | Official |
| Grafana | `grafana/grafana` | Official |
| **Neon** | `kislerdm/neon` | **Community.** Neon publishes no official provider. |
| **Railway** | `terraform-community-providers/railway` | **Community, pre-1.0** (0.6.2). |

This matters in two ways. Practically, a pre-1.0 provider can break between
minor versions, which is why `versions.tf` pins with `~>` and
`.terraform.lock.hcl` is committed. And if you say "provisioned via Terraform"
in an interview, be ready for "which providers?" — the honest answer is that
two of the five are community-maintained, and knowing that is a better signal
than not.

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
autoscaling, Neon history retention beyond 24h, Railway usage past the monthly
credit, and any Grafana Cloud usage past the free metric series limit.

## What is deliberately not here

- **`deploy.yml`.** Nothing is provisioned, so there is nothing to deploy to.
- **DNS / custom domains.** No domain registered yet.
- **Environment variables on the Vercel and Railway projects.** They would have
  to reference outputs that do not exist until after the first apply. Wire them
  in a second pass, once `terraform output` returns real values.
