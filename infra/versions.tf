terraform {
  required_version = ">= 1.9"

  required_providers {
    # Official.
    vercel = {
      source  = "vercel/vercel"
      version = "~> 5.11"
    }
    upstash = {
      source  = "upstash/upstash"
      version = "~> 2.1"
    }
    grafana = {
      source  = "grafana/grafana"
      version = "~> 4.45"
    }

    # Community-maintained. Neon publishes no official Terraform provider and
    # Railway's is pre-1.0 — see infra/README.md before depending on either.
    neon = {
      source  = "kislerdm/neon"
      version = "~> 0.15"
    }
    railway = {
      source  = "terraform-community-providers/railway"
      version = "~> 0.6"
    }
  }

  # State is local for now, and .tfstate is gitignored. That is acceptable for a
  # single operator and unacceptable the moment anyone else runs apply, because
  # local state cannot be locked. Move to a remote backend before that happens.
}
