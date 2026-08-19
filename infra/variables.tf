// ---------------------------------------------------------------------------
// Credentials
//
// No defaults, all sensitive. Supply them from the environment as TF_VAR_*
// so nothing lands in a file:
//
//   export TF_VAR_neon_api_key=...
//
// terraform.tfvars is gitignored, but the environment is safer still — a
// tfvars file is one `git add -f` away from being public.
// ---------------------------------------------------------------------------

variable "neon_api_key" {
  description = "Neon API key. console.neon.tech -> Account settings -> API keys."
  type        = string
  sensitive   = true
}

variable "neon_org_id" {
  description = <<-EOT
    Neon organization id, e.g. org-wispy-sky-28561259.

    Required when the API key is an ORGANIZATION key rather than a personal one.
    Organization keys cannot create a project without it, and cannot read
    /users/me or /regions at all — so if those endpoints 401 while /projects
    works, that is the key type telling you which it is.

    Find it with:
      curl -H "Authorization: Bearer $NEON_API_KEY" \
        https://console.neon.tech/api/v2/users/me/organizations
  EOT
  type        = string
}

variable "upstash_email" {
  description = "Email of the Upstash account."
  type        = string
  sensitive   = true
}

variable "upstash_api_key" {
  description = "Upstash management API key. console.upstash.com -> Account -> Management API."
  type        = string
  sensitive   = true
}

variable "vercel_api_token" {
  description = "Vercel API token. vercel.com/account/tokens."
  type        = string
  sensitive   = true
}

variable "railway_token" {
  description = "Railway account token. railway.app -> Account -> Tokens."
  type        = string
  sensitive   = true
}

variable "grafana_cloud_access_policy_token" {
  description = "Grafana Cloud access policy token with stacks:read/write."
  type        = string
  sensitive   = true
}

// ---------------------------------------------------------------------------
// Naming and placement
// ---------------------------------------------------------------------------

variable "project_name" {
  description = "Base name for every provisioned resource."
  type        = string
  default     = "mise"

  validation {
    // Slugs derived from this feed Grafana and Neon, both of which reject
    // anything but lowercase alphanumerics.
    condition     = can(regex("^[a-z][a-z0-9-]{1,30}$", var.project_name))
    error_message = "project_name must be lowercase alphanumeric with hyphens, starting with a letter."
  }
}

variable "environment" {
  description = "Deployment environment. Part of every resource name."
  type        = string
  default     = "prod"

  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment must be one of: dev, staging, prod."
  }
}

variable "github_repo" {
  description = "owner/name of the GitHub repository Vercel deploys from."
  type        = string
  default     = "dhruv-1100/Mise"
}

// ---------------------------------------------------------------------------
// Regions
//
// Keep these close together. The extractor talks to Postgres and Redis on
// every job; cross-region hops show up directly in the extraction p99 that
// Phase 7 reports against an SLO.
// ---------------------------------------------------------------------------

variable "neon_region" {
  description = "Neon region id, e.g. aws-us-east-1."
  type        = string
  default     = "aws-us-east-1"
}

variable "neon_pg_version" {
  description = "Postgres major version."
  type        = number
  default     = 17
}

variable "upstash_primary_region" {
  description = <<-EOT
    Primary region for the Upstash Redis database, e.g. us-east-1.

    Upstash deprecated regional databases; every database is now "global",
    which means one primary region plus optional read replicas. This is that
    primary. Keep it close to the Neon region — the extractor hits Postgres and
    Redis on every job.
  EOT
  type        = string
  default     = "us-east-1"
}

variable "grafana_region" {
  description = "Grafana Cloud region slug, e.g. prod-us-east-0."
  type        = string
  default     = "prod-us-east-0"
}
