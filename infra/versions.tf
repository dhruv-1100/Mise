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

    google = {
      source  = "hashicorp/google"
      version = "~> 7.45"
    }

    # Community-maintained. Neon publishes no official Terraform provider —
    # see infra/README.md before depending on it.
    neon = {
      source  = "kislerdm/neon"
      version = "~> 0.15"
    }
  }

  # State is local for now, and .tfstate is gitignored. That is acceptable for a
  # single operator and unacceptable the moment anyone else runs apply, because
  # local state cannot be locked. Move to a remote backend before that happens.
}
