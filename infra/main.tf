// Provider configuration only. Resources live in one file per provider.

provider "neon" {
  api_key = var.neon_api_key
}

provider "upstash" {
  email   = var.upstash_email
  api_key = var.upstash_api_key
}

provider "vercel" {
  api_token = var.vercel_api_token
}

provider "railway" {
  token = var.railway_token
}

provider "grafana" {
  cloud_access_policy_token = var.grafana_cloud_access_policy_token
}

locals {
  // Every resource name derives from this, so a second environment is one
  // -var away rather than a find-and-replace.
  name = "${var.project_name}-${var.environment}"
}
